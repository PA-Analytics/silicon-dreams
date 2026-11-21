import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { CameraMeta, SceneMeta, CrtState, NightMeta, SceneMode, TvState } from './types.ts';
import { createCloudMaterial, createSkyDome, createTwilightEnvironment, createNightEnvironment, createNightMist, createNightBackdrop } from './shaders/sky.ts';
import { createSiliconMaterialLibrary, upgradeSceneMaterials, createNightMaterialControls, upgradeNightExtras } from './shaders/materials.ts';
import { createPostPipeline, type QualityTier } from './pipeline.ts';
import { createModeTransition } from "./mode-transition.ts";
import { createChat } from './chat.ts';

const NIGHT_CAMERA_LABELS: Record<string, string> = {
  CAM_DN_04_tower_window: 'Ojo Ventana',
  CAM_DN_03_crt: 'CRT Ojo',
  CAM_DN_05_tv: 'TV Ojos',
  CAM_N_06_receptor_intro: 'Receptor Intro',
};

const CAMERA_LABELS: Record<string, string> = {
  CAM_02_threequarter: 'Hero 3/4',
  CAM_01_front: 'Isla Frontal',
  CAM_05_window: 'Ventana',
  CAM_BIBLE_04_computer: 'CRT / PC',
  CAM_BIBLE_05_television: 'TV / Mueble',
  CAM_BIBLE_06_tree: 'Árbol',
  CAM_BIBLE_07_vines: 'Enredaderas',
  CAM_04_underside: 'Subsuelo',
  CAM_BIBLE_09_entrance: 'Entrada',
  CAM_03_rear: 'Trasera',
  CAM_BIBLE_10_establishing: 'Aérea',
};

const PRESET_ORDER = Object.keys(CAMERA_LABELS);

function computeVerticalFov(camMeta: CameraMeta, aspect: number): number {
  const refAspect = 4 / 3;
  if (aspect >= refAspect) {
    return camMeta.fov43Deg;
  }
  const halfFov43 = THREE.MathUtils.degToRad(camMeta.fov43Deg * 0.5);
  const adapted = 2 * Math.atan((Math.tan(halfFov43) * refAspect) / Math.max(aspect, 0.54));
  return THREE.MathUtils.radToDeg(adapted);
}

async function init(): Promise<void> {
  const appEl = document.getElementById('app')!;
  const loadingEl = document.getElementById('loading')!;
  const loaderFill = document.getElementById('loader-fill')!;
  const loaderStatus = document.getElementById('loader-status')!;
  const backendBadge = document.getElementById('backend-badge')!;
  const statsLine = document.getElementById('stats-line')!;
  const cameraDock = document.getElementById('camera-dock')!;

  const params = new URLSearchParams(window.location.search);
  let currentMode: SceneMode = params.get('mode') === 'night' ? 'night' : 'day';
  document.body.classList.toggle('mode-night', currentMode === 'night');

  const setProgress = (pct: number, text: string) => {
    loaderFill.style.width = `${pct}%`;
    loaderStatus.textContent = text;
  };

  const tStart = performance.now();
  setProgress(10, 'Inicializando WebGPURenderer…');

  const getSize = () => ({
    w: Math.max(appEl.clientWidth || window.innerWidth, 1),
    h: Math.max(appEl.clientHeight || window.innerHeight, 1),
  });

  const { w: initW, h: initH } = getSize();

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('/draco/');
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  const assetsPromise = Promise.all([
    fetch('/scene-meta.json').then((r) => r.json() as Promise<SceneMeta>),
    gltfLoader.loadAsync('/models/silicon-dreams-v1.glb'),
    gltfLoader.loadAsync('/models/clouds-v1.glb'),
  ]);

  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  const tInit = performance.now();
  renderer.setPixelRatio(1);
  renderer.setSize(initW, initH);
  renderer.toneMapping = THREE.AgXToneMapping;
  let dayExposure = 1.16;
  let nightExposure = 1.32;
  renderer.toneMappingExposure = currentMode === 'night' ? nightExposure : dayExposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  appEl.appendChild(renderer.domElement);

  const isWebGPU = Boolean((renderer.backend as { isWebGPUBackend?: boolean })?.isWebGPUBackend);
  backendBadge.textContent = isWebGPU ? 'WebGPU · TSL' : 'WebGL2 · TSL';

  const scene = new THREE.Scene();
  const dayFogColor = new THREE.Color(0x3270c4);
  const nightFogColor = new THREE.Color(0x020309);
  const fog = new THREE.FogExp2(
    currentMode === 'night' ? nightFogColor.getHex() : dayFogColor.getHex(),
    currentMode === 'night' ? 0.0085 : 0.0012,
  );
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(37.3, initW / initH, 0.2, 800);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxDistance = 180;
  controls.minDistance = 2.5;
  if (window.matchMedia('(pointer: coarse)').matches || initW < 640) {
    controls.rotateSpeed = 0.78;
    controls.zoomSpeed = 0.85;
    controls.panSpeed = 0.75;
  }

  setProgress(25, 'Generando cielo, arcoíris e IBL…');

  const nightControls = createNightMaterialControls();
  nightControls.nightMix.value = currentMode === 'night' ? 1.0 : 0.0;

  const rainbowStrength = uniform(0.65);
  const skyCloudAmount = uniform(0.45);
  const cloudOpacity = uniform(1.0);

  const skyDome = createSkyDome(rainbowStrength, skyCloudAmount, nightControls.nightMix);
  skyDome.matrixAutoUpdate = false;
  skyDome.updateMatrix();
  scene.add(skyDome);

  const dayEnvTex = createTwilightEnvironment(renderer);
  let nightEnvTex: THREE.Texture | null = null;
  if (currentMode === 'night') {
    nightEnvTex = createNightEnvironment(renderer);
    scene.environment = nightEnvTex;
    scene.environmentIntensity = 0.38;
  } else {
    scene.environment = dayEnvTex;
    scene.environmentIntensity = 0.72;
  }
  const tEnv = performance.now();

  setProgress(45, 'Cargando escena optimizada (Draco + GPU Instancing)…');

  const [meta, mainGltf, cloudsGltf] = await assetsPromise;
  const tLoad = performance.now();

  setProgress(72, 'Fusionando mallas y compilando TSL…');

  const matLib = createSiliconMaterialLibrary(nightControls);
  const sceneStats = upgradeSceneMaterials(mainGltf.scene, matLib);
  const tMat = performance.now();
  scene.add(mainGltf.scene);

  const sunMeta = meta.lights.find((l) => l.name === 'LGT_Sun');
  const sunDirTo = sunMeta
    ? new THREE.Vector3(...sunMeta.direction).negate().normalize()
    : new THREE.Vector3(-0.6, 0.57, 0.56).normalize();

  const cloudMat = createCloudMaterial(sunDirTo, cloudOpacity, nightControls.nightMix);
  const cloudGroup = cloudsGltf.scene;
  cloudGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = cloudMat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  });
  scene.add(cloudGroup);

  setProgress(86, 'Configurando iluminación y sombras estáticas…');

  const dayLightsGroup = new THREE.Group();
  dayLightsGroup.name = 'SD_Day_Lights';
  const sharedLightsGroup = new THREE.Group();
  sharedLightsGroup.name = 'SD_Shared_Lights';
  const nightLightsGroup = new THREE.Group();
  nightLightsGroup.name = 'SD_Night_Lights';

  dayLightsGroup.visible = currentMode === 'day';
  nightLightsGroup.visible = currentMode === 'night';
  scene.add(dayLightsGroup, sharedLightsGroup, nightLightsGroup);

  let keySunLight: THREE.DirectionalLight | null = null;
  let moonKeyLight: THREE.DirectionalLight | null = null;
  let crtScreenLight: THREE.PointLight | null = null;
  let tvScreenLight: THREE.PointLight | null = null;

  for (const lm of meta.lights) {
    const col = new THREE.Color().setRGB(lm.color[0], lm.color[1], lm.color[2], THREE.SRGBColorSpace);
    if (lm.type === 'SUN') {
      const isKey = lm.name === 'LGT_Sun';
      const dirLight = new THREE.DirectionalLight(col, isKey ? 2.85 : 0.35);
      const d = new THREE.Vector3(...lm.direction).normalize();
      dirLight.position.copy(d.clone().multiplyScalar(-65));
      dirLight.target.position.set(0, 3, -2);
      dirLight.target.updateMatrixWorld();
      dayLightsGroup.add(dirLight.target);
      if (isKey && lm.castShadow) {
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.set(1024, 1024);
        dirLight.shadow.camera.left = -22;
        dirLight.shadow.camera.right = 22;
        dirLight.shadow.camera.top = 22;
        dirLight.shadow.camera.bottom = -22;
        dirLight.shadow.camera.near = 20;
        dirLight.shadow.camera.far = 115;
        dirLight.shadow.camera.updateProjectionMatrix();
        dirLight.shadow.bias = -0.0004;
        dirLight.shadow.normalBias = 0.03;
        dirLight.shadow.radius = 2.0;
        dirLight.shadow.autoUpdate = false;
        dirLight.shadow.needsUpdate = true;
        keySunLight = dirLight;
      }
      dayLightsGroup.add(dirLight);
    } else if (lm.type === 'POINT') {
      const pt = new THREE.PointLight(col, 42, 16, 1.8);
      pt.position.set(...lm.position);
      pt.castShadow = false;
      sharedLightsGroup.add(pt);
    } else if (lm.type === 'AREA') {
      const bounce = new THREE.PointLight(col, 6.2, 7.5, 1.8);
      bounce.position.set(...lm.position).addScaledVector(new THREE.Vector3(...lm.direction), 0.45);
      dayLightsGroup.add(bounce);
    }
  }

  // Upward cool cloud-sea bounce so the sculpted underside rock strata read clearly in Day mode
  const cloudSeaFill = new THREE.HemisphereLight(0x7fa4d8, 0x5c7da8, 0.48);
  dayLightsGroup.add(cloudSeaFill);

  const camByName = new Map(meta.cameras.map((c) => [c.name, c]));
  let activeCamMeta = camByName.get('CAM_02_threequarter') ?? meta.cameras[0];

  const getAdjustedTarget = (cm: CameraMeta): THREE.Vector3 => {
    const t = new THREE.Vector3(...cm.target);
    if (cm.shiftY !== 0) {
      const dist = new THREE.Vector3(...cm.position).distanceTo(t);
      const fovRad = THREE.MathUtils.degToRad(cm.fov43Deg);
      t.y += cm.shiftY * 2.0 * Math.tan(fovRad * 0.5) * dist;
    }
    return t;
  };

  let activeUntil = performance.now() + 1800;
  const wakeRenderer = (durationMs = 1500) => {
    activeUntil = Math.max(activeUntil, performance.now() + durationMs);
  };

  const applyCameraImmediate = (cm: CameraMeta) => {
    activeCamMeta = cm;
    const { w, h } = getSize();
    camera.position.set(...cm.position);
    controls.target.copy(getAdjustedTarget(cm));
    camera.fov = computeVerticalFov(cm, w / h);
    camera.updateProjectionMatrix();
    controls.update();
    wakeRenderer();
  };
  applyCameraImmediate(activeCamMeta);

  let transition: {
    t: number;
    duration: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromFov: number;
    toFov: number;
  } | null = null;

  let orbitAuto = false;
  let orbitAngle = 0;
  const orbitCenter = new THREE.Vector3(...meta.orbit.center);
  const orbitTarget = new THREE.Vector3(...meta.orbit.target);
  const orbitInitOffset = new THREE.Vector3(...meta.orbit.cameraPos).sub(orbitCenter);
  const orbitRadius = Math.hypot(orbitInitOffset.x, orbitInitOffset.z);
  const orbitElevation = meta.orbit.cameraPos[1];
  const orbitStartAngle = Math.atan2(orbitInitOffset.x, orbitInitOffset.z);

  const optOrbit = document.getElementById('opt-orbit') as HTMLInputElement;
  const setActiveButton = (name: string | null) => {
    for (const btn of cameraDock.querySelectorAll<HTMLButtonElement>('.cam-btn')) {
      const isMatch = btn.dataset.cam === name;
      btn.classList.toggle('active', isMatch);
      if (isMatch && window.innerWidth <= 640) {
        btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  };

  const flyToCamera = (cm: CameraMeta) => {
    orbitAuto = false;
    optOrbit.checked = false;
    activeCamMeta = cm;
    setActiveButton(cm.name);
    const { w, h } = getSize();
    transition = {
      t: 0,
      duration: 0.9,
      fromPos: camera.position.clone(),
      toPos: new THREE.Vector3(...cm.position),
      fromTarget: controls.target.clone(),
      toTarget: getAdjustedTarget(cm),
      fromFov: camera.fov,
      toFov: computeVerticalFov(cm, w / h),
    };
    wakeRenderer(1800);
  };

  for (const name of PRESET_ORDER) {
    const cm = camByName.get(name);
    if (!cm) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cam-btn';
    btn.dataset.cam = cm.name;
    btn.textContent = CAMERA_LABELS[name];
    if (cm.name === activeCamMeta.name) btn.classList.add('active');
    btn.addEventListener('click', () => flyToCamera(cm));
    cameraDock.appendChild(btn);
  }

  controls.addEventListener('start', () => {
    transition = null;
    if (orbitAuto) {
      orbitAuto = false;
      optOrbit.checked = false;
    }
    wakeRenderer(2000);
  });
  controls.addEventListener('change', () => wakeRenderer(1400));

  const post = createPostPipeline(renderer, scene, camera);
  post.setNightMode(currentMode === 'night');
  const modeTransition = createModeTransition();

  // Wire UI controls
  const collapseBtn = document.getElementById('collapse-btn') as HTMLButtonElement;
  const controlsBody = document.getElementById('controls-body')!;
  collapseBtn.addEventListener('click', () => {
    const hidden = controlsBody.classList.toggle('collapsed');
    collapseBtn.textContent = hidden ? '+' : '_';
    collapseBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });

  const optQuality = document.getElementById('opt-quality') as HTMLSelectElement;
  const optAo = document.getElementById('opt-ao') as HTMLInputElement;
  const optBloom = document.getElementById('opt-bloom') as HTMLInputElement;
  const optGrain = document.getElementById('opt-grain') as HTMLInputElement;
  const optGrainAmount = document.getElementById('opt-grain-amount') as HTMLInputElement;
  const valGrainAmount = document.getElementById('val-grain-amount')!;
  optGrainAmount.addEventListener('input', () => {
    const amount = Number(optGrainAmount.value);
    post.setGrainAmount(amount);
    valGrainAmount.textContent = amount.toFixed(2);
    wakeRenderer(800);
  });
  const optClouds = document.getElementById('opt-clouds') as HTMLInputElement;
  const optExposure = document.getElementById('opt-exposure') as HTMLInputElement;
  const valExposure = document.getElementById('val-exposure')!;
  const optRainbow = document.getElementById('opt-rainbow') as HTMLInputElement;
  const valRainbow = document.getElementById('val-rainbow')!;
  const optCrtState = document.getElementById('opt-crt-state') as HTMLSelectElement;
  const optTvState = document.getElementById('opt-tv-state') as HTMLSelectElement;
  const optMist = document.getElementById('opt-mist') as HTMLInputElement;
  const optHorror = document.getElementById('opt-horror') as HTMLInputElement;
  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mode-switch .mode-btn'));

  let qualityTier: QualityTier = 'balanced';
  let nightExtrasGroup: THREE.Group | null = null;
  let nightMistGroup: THREE.Group | null = null;
  let nightBackdropGroup: THREE.Group | null = null;
  let nightLoaded = false;
  let nightLoadPromise: Promise<void> | null = null;

  const updateScreenLights = () => {
    const cVal = Number(nightControls.crtState.value) as CrtState;
    const tVal = Number(nightControls.tvState.value) as TvState;
    if (crtScreenLight) {
      crtScreenLight.intensity = cVal === 0 ? 0 : cVal === 1 ? 9.0 : cVal === 2 ? 5.0 : 3.8;
    }
    if (tvScreenLight) {
      tvScreenLight.intensity = tVal === 0 ? 0 : tVal === 1 ? 10.0 : 4.5;
    }
  };

  const loadPngTexture = (loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> =>
    loader.loadAsync(url).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    });

  const ensureNightAssets = (): Promise<void> => {
    if (nightLoaded) return Promise.resolve();
    if (nightLoadPromise) return nightLoadPromise;

    const texLoader = new THREE.TextureLoader();
    nightLoadPromise = Promise.all([
      fetch('/night-meta.json').then((r) => r.json() as Promise<NightMeta>),
      gltfLoader.loadAsync('/models/night-extras-v1.glb'),
      loadPngTexture(texLoader, '/screens/crt_eye.png'),
      loadPngTexture(texLoader, '/screens/crt_signal_overlay.png'),
      loadPngTexture(texLoader, '/screens/tv_multi_eyes.png'),
      loadPngTexture(texLoader, '/screens/window_eye.png'),
      loadPngTexture(texLoader, '/screens/veg_eye.png'),
    ]).then(([nMeta, extrasGltf, crtEye, crtSignal, tvEyes, winEye, vegEye]) => {
      nightControls.crtEyeTex.value = crtEye;
      nightControls.crtSignalTex.value = crtSignal;
      nightControls.tvEyesTex.value = tvEyes;
      nightControls.winEyeTex.value = winEye;
      nightControls.vegEyeTex.value = vegEye;

      if (!nightEnvTex) {
        nightEnvTex = createNightEnvironment(renderer);
      }

      // Build night lights from SILICON_NIGHT_V1.blend metadata
      for (const lm of nMeta.lights) {
        const col = new THREE.Color().setRGB(lm.color[0], lm.color[1], lm.color[2], THREE.SRGBColorSpace);
        if (lm.name === 'LGT_N_Moon_Key') {
          const moon = new THREE.DirectionalLight(col, 1.05);
          const d = new THREE.Vector3(...lm.direction).normalize();
          moon.position.copy(d.clone().multiplyScalar(-65));
          moon.target.position.set(0, 3, -2);
          moon.target.updateMatrixWorld();
          nightLightsGroup.add(moon.target);
          moon.castShadow = true;
          const sSize = qualityTier === 'ultra' ? 1536 : 1024;
          moon.shadow.mapSize.set(sSize, sSize);
          moon.shadow.camera.left = -22;
          moon.shadow.camera.right = 22;
          moon.shadow.camera.top = 22;
          moon.shadow.camera.bottom = -22;
          moon.shadow.camera.near = 20;
          moon.shadow.camera.far = 115;
          moon.shadow.camera.updateProjectionMatrix();
          moon.shadow.bias = -0.0004;
          moon.shadow.normalBias = 0.03;
          moon.shadow.radius = 2.0;
          moon.shadow.autoUpdate = false;
          moon.shadow.needsUpdate = true;
          moonKeyLight = moon;
          nightLightsGroup.add(moon);
        } else if (lm.name === 'LGT_N_Moon_Rim') {
          const rim = new THREE.DirectionalLight(col, 0.44);
          const d = new THREE.Vector3(...lm.direction).normalize();
          rim.position.copy(d.clone().multiplyScalar(-60));
          rim.target.position.set(0, 3, -2);
          rim.target.updateMatrixWorld();
          nightLightsGroup.add(rim.target);
          nightLightsGroup.add(rim);
        } else if (lm.name === 'LGT_Screen_CRT') {
          const pt = new THREE.PointLight(col, 5.0, 8.5, 1.8);
          pt.position.set(...lm.position).addScaledVector(new THREE.Vector3(...lm.direction), 0.45);
          crtScreenLight = pt;
          nightLightsGroup.add(pt);
        } else if (lm.name === 'LGT_Screen_TV') {
          const pt = new THREE.PointLight(col, 4.5, 8.5, 1.8);
          pt.position.set(...lm.position).addScaledVector(new THREE.Vector3(...lm.direction), 0.45);
          tvScreenLight = pt;
          nightLightsGroup.add(pt);
        }
      }

      // Cool midnight upward bounce so rock strata and shadows stay legible
      const nightUnderFill = new THREE.HemisphereLight(0x162442, 0x3b5896, 0.48);
      nightLightsGroup.add(nightUnderFill);
      updateScreenLights();

      // Night extras (2 eye sprites + 7 merged cobwebs)
      const extras = extrasGltf.scene;
      extras.name = 'SD_Night_Extras';
      upgradeNightExtras(extras, nightControls);
      extras.visible = currentMode === 'night' && optHorror.checked;
      nightExtrasGroup = extras;
      scene.add(extras);

      // Low mist around island top (NIGHT_Mist_Low)
      const mist = createNightMist(nMeta.mist.position, nMeta.mist.size);
      mist.visible = currentMode === 'night' && optMist.checked;
      nightMistGroup = mist;
      scene.add(mist);

      // Distant liminal silhouettes in the night abyss
      const backdrop = createNightBackdrop();
      backdrop.visible = currentMode === 'night';
      nightBackdropGroup = backdrop;
      scene.add(backdrop);

      // Night close-up cameras appended to dock with .night-only
      const camSep = document.createElement('span');
      camSep.className = 'cam-sep night-only';
      camSep.setAttribute('aria-hidden', 'true');
      cameraDock.appendChild(camSep);
      for (const cm of nMeta.cameras) {
        const label = NIGHT_CAMERA_LABELS[cm.name];
        if (!label) continue;
        camByName.set(cm.name, cm);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cam-btn night-only';
        btn.dataset.cam = cm.name;
        btn.textContent = label;
        btn.addEventListener('click', () => flyToCamera(cm));
        cameraDock.appendChild(btn);
      }

      nightLoaded = true;
      if (currentMode === 'night') {
        scene.environment = nightEnvTex;
        if (moonKeyLight) moonKeyLight.shadow.needsUpdate = true;
        wakeRenderer(1200);
      }
    });

    return nightLoadPromise.catch((error) => {
      nightLoadPromise = null;
      throw error;
    });
  };

  const applyMode = async (mode: SceneMode) => {
    if (mode === 'night') await ensureNightAssets();
    currentMode = mode;
    post.setNightMode(mode === 'night');
    const isNight = mode === 'night';
    document.body.classList.toggle('mode-night', isNight);
    for (const btn of modeButtons) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }

    if (isNight && !nightLoaded) {
      await ensureNightAssets();
    }

    nightControls.nightMix.value = isNight ? 1.0 : 0.0;
    dayLightsGroup.visible = !isNight;
    nightLightsGroup.visible = isNight;
    if (nightExtrasGroup) nightExtrasGroup.visible = isNight && optHorror.checked;
    if (nightMistGroup) nightMistGroup.visible = isNight && optMist.checked;
    if (nightBackdropGroup) nightBackdropGroup.visible = isNight;

    if (isNight) {
      if (!nightEnvTex) nightEnvTex = createNightEnvironment(renderer);
      scene.environment = nightEnvTex;
      scene.environmentIntensity = 0.38;
      fog.color.copy(nightFogColor);
      fog.density = 0.0085;
      if (moonKeyLight) moonKeyLight.shadow.needsUpdate = true;
    } else {
      scene.environment = dayEnvTex;
      scene.environmentIntensity = 0.72;
      fog.color.copy(dayFogColor);
      fog.density = 0.0012;
      if (keySunLight) keySunLight.shadow.needsUpdate = true;
    }

    const exp = isNight ? nightExposure : dayExposure;
    renderer.toneMappingExposure = exp;
    optExposure.value = exp.toFixed(2);
    valExposure.textContent = exp.toFixed(2);

    wakeRenderer(1500);
  };

  const requestMode = async (m: SceneMode) => {
      if (m === currentMode || modeTransition.busy) return;
      const minMs = nightLoaded ? 600 : 1000;
      await modeTransition.run(m, async () => {
        controls.enabled = false;
        try {
          await applyMode(m);
          await renderer.compileAsync(scene, camera);
          post.renderFrame();
        } finally {
          controls.enabled = true;
        }
      }, minMs);
  };
  const chatWindow = createChat(async (action) => { await requestMode(action.mode); });
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => { void requestMode(btn.dataset.mode === 'night' ? 'night' : 'day'); });
  }

  // Sync exposure UI if starting directly in ?mode=night
  if (currentMode === 'night') {
    for (const btn of modeButtons) {
      btn.classList.toggle('active', btn.dataset.mode === 'night');
    }
    optExposure.value = nightExposure.toFixed(2);
    valExposure.textContent = nightExposure.toFixed(2);
    await ensureNightAssets();
  }

  const updateShadowMapResolution = (light: THREE.DirectionalLight | null, size: number) => {
    if (!light || light.shadow.mapSize.x === size) return;
    light.shadow.mapSize.set(size, size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.needsUpdate = true;
  };

  const applyQualityTier = (tier: QualityTier) => {
    qualityTier = tier;
    post.setQuality(tier);
    const { w, h } = getSize();
    if (tier === 'ultra') {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      optAo.checked = true;
      post.setAoEnabled(true);
      updateShadowMapResolution(keySunLight, 1536);
      updateShadowMapResolution(moonKeyLight, 1536);
    } else {
      renderer.setPixelRatio(1);
      if (tier === 'eco') {
        optAo.checked = false;
        post.setAoEnabled(false);
      }
      updateShadowMapResolution(keySunLight, 1024);
      updateShadowMapResolution(moonKeyLight, 1024);
    }
    if (w >= 2 && h >= 2) renderer.setSize(w, h);
    wakeRenderer(1200);
  };

  optQuality.addEventListener('change', () => applyQualityTier(optQuality.value as QualityTier));
  optOrbit.addEventListener('change', () => {
    orbitAuto = optOrbit.checked;
    if (orbitAuto) {
      transition = null;
      orbitAngle = 0;
      setActiveButton(null);
      const orbitMeta = camByName.get('CAM_orbit');
      if (orbitMeta) {
        activeCamMeta = orbitMeta;
        const { w, h } = getSize();
        camera.fov = computeVerticalFov(orbitMeta, w / h);
        camera.updateProjectionMatrix();
      }
    }
    wakeRenderer(1200);
  });
  optAo.addEventListener('change', () => {
    post.setAoEnabled(optAo.checked);
    wakeRenderer(800);
  });
  optBloom.addEventListener('change', () => {
    post.setBloomEnabled(optBloom.checked);
    wakeRenderer(800);
  });
  const syncGrainUi = () => {
    const enabled = optGrain.checked;
    optGrainAmount.disabled = !enabled;
    optGrainAmount.closest('.slider-row')?.classList.toggle('is-disabled', !enabled);
  };
  syncGrainUi();
  optGrain.addEventListener('change', () => {
    post.setGrainEnabled(optGrain.checked);
    syncGrainUi();
    wakeRenderer(800);
  });
  optClouds.addEventListener('change', () => {
    cloudGroup.visible = optClouds.checked;
    cloudOpacity.value = optClouds.checked ? 1.0 : 0.0;
    skyCloudAmount.value = optClouds.checked ? 0.45 : 0.0;
    rainbowStrength.value = optClouds.checked ? Number(optRainbow.value) : 0.0;
    wakeRenderer(800);
  });
  optExposure.addEventListener('input', () => {
    const v = Number(optExposure.value);
    if (currentMode === 'night') nightExposure = v;
    else dayExposure = v;
    renderer.toneMappingExposure = v;
    valExposure.textContent = v.toFixed(2);
    wakeRenderer(600);
  });
  optRainbow.addEventListener('input', () => {
    const v = Number(optRainbow.value);
    rainbowStrength.value = optClouds.checked ? v : 0.0;
    valRainbow.textContent = v.toFixed(2);
    wakeRenderer(600);
  });
  optCrtState.addEventListener('change', () => {
    nightControls.crtState.value = Number(optCrtState.value);
    updateScreenLights();
    wakeRenderer(800);
  });
  optTvState.addEventListener('change', () => {
    nightControls.tvState.value = Number(optTvState.value);
    updateScreenLights();
    wakeRenderer(800);
  });
  optMist.addEventListener('change', () => {
    if (nightMistGroup) nightMistGroup.visible = currentMode === 'night' && optMist.checked;
    wakeRenderer(600);
  });
  optHorror.addEventListener('change', () => {
    if (nightExtrasGroup) nightExtrasGroup.visible = currentMode === 'night' && optHorror.checked;
    wakeRenderer(600);
  });

  const handleResize = () => {
    const { w, h } = getSize();
    if (w < 2 || h < 2) return;
    camera.aspect = w / h;
    camera.fov = computeVerticalFov(activeCamMeta, w / h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    wakeRenderer(800);
  };
  window.addEventListener('resize', handleResize);
  const ro = new ResizeObserver(handleResize);
  ro.observe(appEl);

  setProgress(95, 'Precompilando shaders WebGPU…');
  const tPreRender = performance.now();
  await renderer.compileAsync(scene, camera);
  if (initW >= 2 && initH >= 2) {
    post.renderFrame();
  }
  const tDone = performance.now();
  console.info(
    `[PERF] init=${Math.round(tInit - tStart)}ms env=${Math.round(tEnv - tInit)}ms glb=${Math.round(tLoad - tEnv)}ms mat=${Math.round(tMat - tLoad)}ms firstFrame=${Math.round(tDone - tPreRender)}ms total=${Math.round(tDone - tStart)}ms draws=${renderer.info.render.drawCalls} tris=${renderer.info.render.triangles}`,
  );
  loadingEl.classList.add('hidden');

  // Preload night bundle silently after Day firstFrame so Day↔Night switch is instant
  if (currentMode === 'day') {
    setTimeout(() => {
      void ensureNightAssets().catch((err) => console.warn('Night preload failed:', err));
    }, 150);
  }

  const timer = new THREE.Timer();
  timer.connect(document);

  let fpsFrames = 0;
  let fpsAccum = 0;
  let lastIdleRender = 0;

  statsLine.textContent = `${sceneStats.meshes} mallas · ${sceneStats.instances.toLocaleString()} inst. GN · listo`;

  renderer.setAnimationLoop(() => {
    const { w, h } = getSize();
    if (w < 2 || h < 2) return;

    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const now = performance.now();

    if (transition) {
      transition.t = Math.min(1, transition.t + dt / transition.duration);
      const u = 1 - Math.pow(1 - transition.t, 3);
      camera.position.lerpVectors(transition.fromPos, transition.toPos, u);
      controls.target.lerpVectors(transition.fromTarget, transition.toTarget, u);
      camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.toFov, u);
      camera.updateProjectionMatrix();
      if (transition.t >= 1) transition = null;
      wakeRenderer(500);
    } else if (orbitAuto) {
      orbitAngle += dt * ((Math.PI * 2) / 14.0);
      const theta = orbitStartAngle - orbitAngle;
      camera.position.set(
        orbitCenter.x + Math.sin(theta) * orbitRadius,
        orbitElevation,
        orbitCenter.z + Math.cos(theta) * orbitRadius,
      );
      controls.target.copy(orbitTarget);
      wakeRenderer(500);
    }

    const isActive = now < activeUntil;
    if (qualityTier === 'eco' && !isActive) {
      return;
    }
    if (qualityTier === 'balanced' && !isActive) {
      if (now - lastIdleRender < 66) return;
      lastIdleRender = now;
    }

    controls.update();
    post.renderFrame();

    fpsFrames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.75) {
      const fps = Math.round(fpsFrames / fpsAccum);
      const calls = renderer.info.render.drawCalls;
      const modeTag = !isActive && qualityTier === 'balanced' ? ' · Reposo' : '';
      statsLine.textContent = `${calls} draws · ${sceneStats.instances.toLocaleString()} inst. · ${fps} FPS${modeTag}`;
      fpsFrames = 0;
      fpsAccum = 0;
    }
  });

  const cleanup = () => {
    ro.disconnect();
    modeTransition.dispose();
    chatWindow.dispose();
    post.dispose();
    renderer.setAnimationLoop(null);
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) {
          if ((v as THREE.Texture | null)?.isTexture) (v as THREE.Texture).dispose();
        }
        m.dispose();
      }
    });
    dayEnvTex.dispose();
    nightEnvTex?.dispose();
    renderer.dispose();
  };
  window.addEventListener('pagehide', cleanup);
  (import.meta as unknown as { hot?: { dispose: (fn: () => void) => void } }).hot?.dispose(cleanup);
}

init().catch((err) => {
  const status = document.getElementById('loader-status');
  if (status) status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
