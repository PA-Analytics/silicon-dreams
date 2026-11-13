import * as THREE from 'three/webgpu';
import {
  builtinAOContext,
  clamp,
  dot,
  emissive,
  float,
  fract,
  luminance,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenCoordinate,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4, min, sin } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

export type QualityTier = 'eco' | 'balanced' | 'ultra';

export interface PostPipelineControls {
  renderFrame: () => void;
  setQuality: (tier: QualityTier) => void;
  setAoEnabled: (enabled: boolean) => void;
  setBloomEnabled: (enabled: boolean) => void;
  setGrainEnabled: (enabled: boolean) => void;
  setGrainAmount: (amount: number) => void;
  setNightMode: (enabled: boolean) => void;
  dispose: () => void;
}

export function createPostPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostPipelineControls {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  const bloomStrength = uniform(1.0);
  const grainStrength = uniform(1.0);
  const grainSeed = uniform(0);
  const grainCellSize = uniform(1.55);
  let grainEnabled = true;
  let grainAmount = 1.0;
  const nightMix = uniform(0.0);

  let currentTier: QualityTier = 'balanced';
  let aoEnabled = false;

  // Lazy-created passes so Eco/Balanced don't pay for GTAO prePass unless enabled
  let fastNode: ReturnType<typeof vec4> | null = null;
  let aoNode: ReturnType<typeof vec4> | null = null;
  let ecoNode: ReturnType<typeof vec4> | null = null;

  const buildChain = (withAo: boolean, withBloom = true) => {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, emissive }));

    if (withAo) {
      const prePass = pass(scene, camera, { samples: 0 });
      prePass.setMRT(mrt({ output: normalView }));
      const aoPass = ao(prePass.getTextureNode('depth'), prePass.getTextureNode(), camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 0.75;
      aoPass.scale.value = 1.15;
      aoPass.thickness.value = 1.25;
      aoPass.samples.value = 6;
      scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    }

    const sceneColor = scenePass.getTextureNode('output');
    const emissiveTex = scenePass.getTextureNode('emissive');

    // Subpixel chromatic bleed, strongest at the edges; never distort geometry.
    const edge = screenUV.sub(0.5);
    const bleed = edge.mul(dot(edge, edge)).mul(0.0036).mul(grainStrength);
    const analogScene = vec4(
      sceneColor.sample(screenUV.add(bleed)).r,
      sceneColor.g,
      sceneColor.sample(screenUV.sub(bleed)).b,
      sceneColor.a,
    );
    const modeBloomBoost = mix(float(0.95), float(1.60), nightMix);
    const combinedLinear = withBloom
      ? analogScene.add(
          bloom(
            emissiveTex.add(max(vec4(0.0), sceneColor.sub(vec4(0.88, 0.88, 0.88, 0.0))).mul(0.32)),
            0.55,
            0.56,
            0.08,
          ).mul(bloomStrength).mul(modeBloomBoost),
        )
      : analogScene;

    // Keep Day blacks crisp for vivid AgX Punchy contrast; preserve tiny shadow lift only at night
    const shadowLift = mix(vec3(0.0, 0.0, 0.0), vec3(0.001, 0.001, 0.003), nightMix);
    const liftedLinear = vec4(combinedLinear.rgb.add(shadowLift), combinedLinear.a);

    const displayOut = fxaa(renderOutput(liftedLinear)) as unknown as ReturnType<typeof vec4>;

    // A softly faded tape, not a glitch: shadow-weighted luma/chroma grain.
      // Hold each grain exposure at 15 Hz even while the camera renders at 60 Hz.
      // A fixed component keeps texture legible in motion without flashing.
      const px = screenCoordinate.xy.div(grainCellSize).floor();
      const tSeed = grainSeed.mul(17.13);
      // Arithmetic hash avoids diagonal banding from sin() precision on GPUs.
      const hashGrain = (position: typeof px) => {
        const p = fract(vec3(position.x, position.y, position.x).mul(0.1031)).toVar();
        const q = p.add(dot(p, p.yzx.add(33.33))).toVar();
        return fract(q.x.add(q.y).mul(q.z));
      };
      const h1 = hashGrain(px.add(tSeed));
      const h2 = hashGrain(px.add(vec2(tSeed.add(91.7), tSeed.add(47.3))));
      const fixedGrain = hashGrain(px.add(vec2(19.1, 73.7))).sub(0.5);
      const monoGrain = h1.sub(0.5).mul(0.62).add(fixedGrain.mul(0.38));
      const luma = luminance(displayOut.rgb);
      // Soften highlights and very deep night sky voids so grain frames the tower instead of fogging the sky.
      const deepShadowSoften = smoothstep(float(0.012), float(0.085), luma).mul(0.56).add(0.44);
      const toneWeight = float(1.0).sub(smoothstep(float(0.52), float(0.92), luma)).mul(0.65).add(0.35);
      const grainAmp = mix(float(0.082), float(0.074), nightMix).mul(toneWeight).mul(deepShadowSoften).mul(grainStrength);
      const chroma = vec3(h2.sub(0.5), monoGrain.mul(-0.35), h2.sub(0.5).negate()).mul(0.010).mul(deepShadowSoften).mul(grainStrength);
      const edgeFalloff = smoothstep(float(0.10), float(0.48), dot(edge, edge));
      const vignette = float(1).sub(edgeFalloff.mul(0.13).mul(grainStrength));
      // AgX Punchy / Weirdcore color grade: counteract Three.js base AgX desaturation
      const cMax = max(displayOut.r, max(displayOut.g, displayOut.b));
      const cMin = min(displayOut.r, min(displayOut.g, displayOut.b));
      const sat = cMax.sub(cMin);
      const gradeAmt = clamp(grainStrength, 0.0, 1.25);
      const satBase = mix(float(0.24), float(0.14), nightMix);
      const vibBoost = float(1.0).sub(sat).mul(mix(float(0.46), float(0.26), nightMix));
      const vivid = clamp(mix(vec3(luma), displayOut.rgb, float(1.0).add(satBase.add(vibBoost).mul(gradeAmt))), 0.0, 1.0);

      // Film-style Punchy S-curve contrast + eerie Night void crush
      const dayCurve = smoothstep(float(0.03), float(0.95), vivid);
      const nightCurve = smoothstep(float(0.035), float(0.93), vivid);
      const contrasted = mix(vivid, mix(dayCurve, nightCurve, nightMix), gradeAmt.mul(mix(float(0.36), float(0.42), nightMix)));

      const daySplit = contrasted.mul(mix(vec3(0.96, 1.01, 1.05), vec3(1.06, 1.02, 0.93), smoothstep(float(0.25), float(0.85), luma)));
      const nightSplit = contrasted.mul(mix(vec3(0.92, 0.92, 1.06), vec3(1.06, 0.98, 1.02), smoothstep(float(0.22), float(0.85), luma)));
      const graded = mix(contrasted, mix(daySplit, nightSplit, nightMix), gradeAmt);

      // Subtle CRT/camcorder micro-scanline modulation (~1.4%)
      const scanWave = sin(screenCoordinate.y.mul(1.15)).mul(0.014).mul(gradeAmt).add(1.0);
      const shadowTint = mix(vec3(0.002, 0.006, 0.016), vec3(0.005, 0.001, 0.012), nightMix)
        .mul(float(1).sub(luma))
        .mul(gradeAmt);
      const faded = graded.mul(vignette).mul(scanWave).add(shadowTint);
      const finalColor = clamp(faded.add(vec3(monoGrain.mul(grainAmp))).add(chroma), 0.0, 1.0);
      return vec4(finalColor, displayOut.a);
  };

  const applyOutputNode = () => {
    if (currentTier === 'eco') {
      if (!ecoNode) ecoNode = buildChain(false, false);
      pipeline.outputNode = ecoNode;
    } else if (aoEnabled) {
      if (!aoNode) aoNode = buildChain(true);
      pipeline.outputNode = aoNode;
    } else {
      if (!fastNode) fastNode = buildChain(false);
      pipeline.outputNode = fastNode;
    }
    pipeline.needsUpdate = true;
  };

  applyOutputNode();

  return {
    renderFrame: () => {
      grainSeed.value = grainFrameAt(performance.now()) % 4096;
      grainCellSize.value = 1.55 * renderer.getPixelRatio();
      pipeline.render();
    },
    setQuality: (tier: QualityTier) => {
      currentTier = tier;
      applyOutputNode();
    },
    setAoEnabled: (enabled: boolean) => {
      aoEnabled = enabled;
      applyOutputNode();
    },
    setBloomEnabled: (enabled: boolean) => {
      bloomStrength.value = enabled ? 1.0 : 0.0;
    },
    setGrainAmount: (amount: number) => {
      grainAmount = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1.8) : 1;
      grainStrength.value = grainEnabled ? grainAmount : 0;
    },
    setNightMode: (enabled: boolean) => {
      nightMix.value = enabled ? 1 : 0;
    },
    dispose: () => pipeline.dispose(),
    setGrainEnabled: (enabled: boolean) => {
      grainEnabled = enabled;
      grainStrength.value = grainEnabled ? grainAmount : 0;
    },
  };
}
export function grainFrameAt(elapsedMs: number): number {
  return Math.floor(elapsedMs * 15 / 1000);
}

