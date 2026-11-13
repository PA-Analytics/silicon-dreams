"""Export night-only assets and metadata from SILICON_NIGHT_V1.blend without altering the .blend:
- Converts HORROR_COBWEBS curves to meshes and merges into HORROR_Cobwebs_Merged
- Keeps HORROR_EYES (EYE_Tower_Window_F_R4_R, EYE_Foliage_Shrub_L2) with UVs intact
- Exports public/models/night-extras-v1.glb (Draco)
- Copies screens/*.png into public/screens/
- Writes public/night-meta.json (night lights, cameras, mist bounds, exposure, screen local bounds)
"""
import bpy
import json
import math
import os
import shutil
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
THREE_ROOT = os.path.dirname(HERE)
NIGHT_DIR = os.path.normpath(os.path.join(THREE_ROOT, "..", "night_version"))
BLEND_PATH = os.path.join(NIGHT_DIR, "SILICON_NIGHT_V1.blend")
OUT_MODELS = os.path.join(THREE_ROOT, "public", "models")
OUT_SCREENS = os.path.join(THREE_ROOT, "public", "screens")
OUT_META = os.path.join(THREE_ROOT, "public", "night-meta.json")

os.makedirs(OUT_MODELS, exist_ok=True)
os.makedirs(OUT_SCREENS, exist_ok=True)

bpy.ops.wm.open_mainfile(filepath=BLEND_PATH)

AXIS_MAT = Matrix.Rotation(-math.pi / 2.0, 4, "X")


def to_three_vec(v):
    tv = AXIS_MAT @ Vector(v)
    return [round(tv.x, 5), round(tv.y, 5), round(tv.z, 5)]


def to_three_quat(mat_world):
    tm = AXIS_MAT @ mat_world
    q = tm.to_quaternion()
    return [round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)]


def to_three_dir(mat_world, local_axis=(0.0, 0.0, -1.0)):
    v = (mat_world.to_3x3() @ Vector(local_axis)).normalized()
    tv = (AXIS_MAT.to_3x3() @ v).normalized()
    return [round(tv.x, 6), round(tv.y, 6), round(tv.z, 6)]


# 1. Copy crisp screen & eye PNGs
src_screens = os.path.join(NIGHT_DIR, "screens")
copied_screens = []
for fname in sorted(os.listdir(src_screens)):
    if fname.lower().endswith(".png"):
        shutil.copy2(os.path.join(src_screens, fname), os.path.join(OUT_SCREENS, fname))
        copied_screens.append(fname)

# 2. Convert HORROR_COBWEBS curves to meshes and join into 1 draw call
cw_col = bpy.data.collections.get("HORROR_COBWEBS")
web_objs = [o for o in (cw_col.objects if cw_col else []) if o.type == "CURVE"]
if web_objs:
    bpy.ops.object.select_all(action="DESELECT")
    for o in web_objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = web_objs[0]
    bpy.ops.object.convert(target="MESH")

web_meshes = [o for o in (cw_col.objects if cw_col else []) if o.type == "MESH"]
merged_webs = None
if len(web_meshes) > 1:
    bpy.ops.object.select_all(action="DESELECT")
    for o in web_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = web_meshes[0]
    bpy.ops.object.join()
    merged_webs = bpy.context.view_layer.objects.active
    merged_webs.name = "HORROR_Cobwebs_Merged"
elif web_meshes:
    merged_webs = web_meshes[0]
    merged_webs.name = "HORROR_Cobwebs_Merged"

# Ensure cobwebs have a UV layer so glTF export is clean
if merged_webs and not merged_webs.data.uv_layers:
    merged_webs.data.uv_layers.new(name="UVMap")

# 3. Collect HORROR_EYES objects + add pitch-black interior void planes behind eyes
eye_col = bpy.data.collections.get("HORROR_EYES")
eye_objs = [o for o in (eye_col.objects if eye_col else []) if o.type == "MESH"]

void_mat = bpy.data.materials.get("SD_N_Void_Black") or bpy.data.materials.new("SD_N_Void_Black")
void_mat.use_nodes = False
void_mat.diffuse_color = (0.002, 0.002, 0.004, 1.0)

# Window F_R4_R full interior void sitting behind eye (Y=2.26) and in front of striped curtain (Y=2.335)
void_win_me = bpy.data.meshes.new("EYE_Tower_Window_Void_F_R4_R")
void_win_me.from_pydata(
    [(0.49, 2.30, 9.54), (2.74, 2.30, 9.54), (2.74, 2.30, 11.53), (0.49, 2.30, 11.53)],
    [],
    [(0, 1, 2, 3)],
)
void_win_me.uv_layers.new(name="UVMap")
void_win_me.materials.append(void_mat)
void_win_obj = bpy.data.objects.new("EYE_Tower_Window_Void_F_R4_R", void_win_me)
eye_col.objects.link(void_win_obj)

# Deep shadow pocket behind foliage eye (-9.95, 1.15, 0.55)
void_veg_me = bpy.data.meshes.new("EYE_Foliage_Void_L2")
void_veg_me.from_pydata(
    [(-0.32, 0.0, -0.22), (0.32, 0.0, -0.22), (0.32, 0.0, 0.22), (-0.32, 0.0, 0.22)],
    [],
    [(0, 1, 2, 3)],
)
void_veg_me.uv_layers.new(name="UVMap")
void_veg_me.materials.append(void_mat)
void_veg_obj = bpy.data.objects.new("EYE_Foliage_Void_L2", void_veg_me)
veg_eye_obj = bpy.data.objects.get("EYE_Foliage_Shrub_L2")
if veg_eye_obj:
    void_veg_obj.matrix_world = veg_eye_obj.matrix_world.copy()
    void_veg_obj.location += Vector((0.0, 0.055, 0.0))
else:
    void_veg_obj.location = (-9.95, 1.21, 0.55)
eye_col.objects.link(void_veg_obj)

# 4. Export night-extras-v1.glb
bpy.ops.object.select_all(action="DESELECT")
extras = eye_objs + [void_win_obj, void_veg_obj] + ([merged_webs] if merged_webs else [])
for o in extras:
    o.hide_set(False)
    o.select_set(True)

extras_glb = os.path.join(OUT_MODELS, "night-extras-v1.glb")
bpy.ops.export_scene.gltf(
    filepath=extras_glb,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="PLACEHOLDER",
    export_attributes=False,
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=12,
)
print(f"Exported {extras_glb} ({len(extras)} objects): {os.path.getsize(extras_glb):,} bytes")

# 5. Compute exact screen local bounds in Three.js coordinates (x_b, z_b, -y_b)
screen_bounds = {}
for oname, mat_key in (("PRP_CRT", "SD_Screen_CRT"), ("PRP_TV", "SD_Screen_TV")):
    ob = bpy.data.objects.get(oname)
    if not ob:
        continue
    slot_idx = next(
        (i for i, ms in enumerate(ob.material_slots) if ms.material and mat_key in ms.material.name),
        None,
    )
    if slot_idx is None:
        continue
    pts = [
        AXIS_MAT @ ob.data.vertices[vi].co
        for p in ob.data.polygons
        if p.material_index == slot_idx
        for vi in p.vertices
    ]
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    screen_bounds[mat_key] = {
        "minX": round(min(xs), 5),
        "maxX": round(max(xs), 5),
        "minY": round(min(ys), 5),
        "maxY": round(max(ys), 5),
    }

# 6. Export night cameras & night lights
EXPLICIT_TARGETS = {
    "CAM_DN_01_hero": (0.0, 2.5, 4.0),
    "CAM_DN_02_vertical": (0.0, 2.5, 9.0),
    "CAM_DN_03_crt": (-7.758, -0.937, 2.825),
    "CAM_DN_04_tower_window": (1.62, 2.26, 10.4),
    "CAM_DN_05_tv": (5.649, 0.143, 1.115),
    "CAM_N_06_receptor_intro": (0.0, -5.0, -0.05),
}

night_cameras = []
for col_name in ("CAMERA_DAY_NIGHT_MATCH", "CAMERA_NIGHT"):
    ccol = bpy.data.collections.get(col_name)
    if not ccol:
        continue
    for o in sorted(ccol.objects, key=lambda x: x.name):
        if o.type != "CAMERA":
            continue
        mw = o.matrix_world
        pos = to_three_vec(mw.translation)
        fwd = to_three_dir(mw, (0.0, 0.0, -1.0))
        quat = to_three_quat(mw)
        lens = float(o.data.lens)
        sensor_w = float(o.data.sensor_width)
        if o.name in EXPLICIT_TARGETS:
            target = to_three_vec(EXPLICIT_TARGETS[o.name])
        else:
            p0 = mw.translation
            d0 = (mw.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
            center_b = Vector((0.0, 2.5, 4.0))
            dist = max(4.0, (center_b - p0).dot(d0))
            target = to_three_vec(p0 + d0 * dist)
        sensor_h_43 = sensor_w * (3.0 / 4.0)
        fov_43 = math.degrees(2.0 * math.atan(sensor_h_43 / (2.0 * lens)))
        night_cameras.append({
            "name": o.name,
            "position": pos,
            "target": target,
            "forward": fwd,
            "quaternion": quat,
            "lensMm": round(lens, 2),
            "sensorWidthMm": round(sensor_w, 2),
            "fov43Deg": round(fov_43, 3),
            "shiftX": round(float(o.data.shift_x), 4),
            "shiftY": round(float(o.data.shift_y), 4),
        })

night_lights = []
for o in sorted(bpy.data.objects, key=lambda x: x.name):
    if o.type != "LIGHT" or o.hide_render:
        continue
    mw = o.matrix_world
    ld = o.data
    night_lights.append({
        "name": o.name,
        "type": ld.type,
        "position": to_three_vec(mw.translation),
        "direction": to_three_dir(mw, (0.0, 0.0, -1.0)),
        "color": [round(float(c), 4) for c in ld.color],
        "energy": round(float(ld.energy), 4),
        "angle": round(float(getattr(ld, "angle", 0.0)), 4) if hasattr(ld, "angle") else None,
        "size": round(float(getattr(ld, "size", 0.0)), 4) if hasattr(ld, "size") else None,
        "sizeY": round(float(getattr(ld, "size_y", 0.0)), 4) if hasattr(ld, "size_y") else None,
        "castShadow": bool(getattr(ld, "use_shadow", True)),
    })

mist_obj = bpy.data.objects.get("NIGHT_Mist_Low")
mist_info = {
    "position": to_three_vec(mist_obj.location) if mist_obj else [0.0, 1.2, -0.5],
    "size": [
        round(float(mist_obj.scale.x), 3),
        round(float(mist_obj.scale.z), 3),
        round(float(mist_obj.scale.y), 3),
    ] if mist_obj else [46.0, 6.0, 36.0],
}

scene = bpy.context.scene
night_meta = {
    "source": "SILICON_NIGHT_V1.blend",
    "exposure": round(float(scene.view_settings.exposure), 4),
    "lights": night_lights,
    "cameras": night_cameras,
    "mist": mist_info,
    "screenBounds": screen_bounds,
    "screens": copied_screens,
}
with open(OUT_META, "w", encoding="utf-8") as f:
    json.dump(night_meta, f, indent=2)
print(f"Wrote {OUT_META}: {len(night_cameras)} night cameras, {len(night_lights)} night lights, {len(copied_screens)} screen PNGs")
