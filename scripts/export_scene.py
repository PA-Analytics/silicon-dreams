"""Export SILICON_V1.0.blend into optimized web-ready Three.js assets:
- Applies modifiers cleanly before joining/decimating
- Rebuilds the island underside into a unified, 360-deg sculpted stratified rock hull
  (eliminates radial triangle fans, floating spikes, and missing rear rock mass)
- Reduces excess Geometry Nodes grass density and decimates over-tessellated meshes
- Packs custom attributes (path, _v4_soil, _v4_damp, tint, TX_Curvature, rock/soil blend) into TEXCOORD_1 (SD_DATA)
- Outputs:
  - public/models/silicon-dreams-v1.glb (Draco + EXT_mesh_gpu_instancing)
  - public/models/clouds-v1.glb (Draco)
  - public/scene-meta.json
"""
import bpy
import bmesh
import json
import math
import os
from mathutils import Matrix, Vector, noise

HERE = os.path.dirname(os.path.abspath(__file__))
THREE_ROOT = os.path.dirname(HERE)
BLEND_PATH = os.path.normpath(os.path.join(THREE_ROOT, "..", "SILICON_V1.0.blend"))
OUT_MODELS = os.path.join(THREE_ROOT, "public", "models")
OUT_META = os.path.join(THREE_ROOT, "public", "scene-meta.json")

os.makedirs(OUT_MODELS, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=BLEND_PATH)

# Blender Z-up -> glTF/Three.js Y-up: (x, y, z) -> (x, z, -y)
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


def ensure_uvs(obj):
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    if "SD_DATA" not in me.uv_layers:
        uv_sd = me.uv_layers.new(name="SD_DATA")
        for loop in uv_sd.data:
            loop.uv = (0.0, 1.0)


def apply_non_gn_modifiers(obj):
    if obj.type != "MESH" or not obj.modifiers:
        return
    mods = [m for m in obj.modifiers if m.type != "NODES"]
    if not mods:
        return
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for m in mods:
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except Exception as exc:
            print(f"Warning applying modifier {m.name} on {obj.name}: {exc}")
            try:
                obj.modifiers.remove(m)
            except Exception:
                pass


# 1. Optimize Geometry Nodes grass & flowers density for web performance
def tune_gn_density(obj_name, new_density, scale_min, scale_max):
    ob = bpy.data.objects.get(obj_name)
    if not ob or not ob.modifiers:
        return
    mod = ob.modifiers[0]
    if mod.type != "NODES" or not mod.node_group:
        return
    inputs = {
        i.name: i.identifier
        for i in mod.node_group.interface.items_tree
        if i.item_type == "SOCKET" and i.in_out == "INPUT"
    }
    for key, val in (("Density", new_density), ("Scale Min", scale_min), ("Scale Max", scale_max)):
        if key in inputs:
            getattr(mod.properties.inputs, inputs[key]).value = val
    ob.data.update()


tune_gn_density("VEG_Grass", 10.5, 0.9, 1.95)
tune_gn_density("VEG_Flowers", 0.85, 0.85, 1.75)

# 2. Convert visible CURVE objects (tree trunk, rebar, ivy/shrub stems) to MESH
curves_to_convert = [
    o for o in bpy.data.objects
    if o.type == "CURVE" and not o.hide_render and not o.name.startswith("BLK_") and "Cutter" not in o.name
]
if curves_to_convert:
    bpy.ops.object.select_all(action="DESELECT")
    for o in curves_to_convert:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = curves_to_convert[0]
    bpy.ops.object.convert(target="MESH")
    print(f"Converted {len(curves_to_convert)} CURVE objects to MESH")

# 3. Apply Boolean/other non-GN modifiers cleanly BEFORE packing UVs or joining
for o in list(bpy.data.objects):
    if o.type != "MESH" or o.hide_render:
        continue
    if o.name.startswith("BLK_") or "Cutter" in o.name or o.name == "V3_Slab_End_Erosion":
        continue
    apply_non_gn_modifiers(o)

# 4. Pack custom scalar attributes into TEXCOORD_1 ("SD_DATA") BEFORE decimation/joining
def pack_sd_data(obj, attr_u, attr_v=None):
    me = obj.data
    ensure_uvs(obj)
    uv_sd = me.uv_layers["SD_DATA"]
    a_u = me.attributes.get(attr_u)
    a_v = me.attributes.get(attr_v) if attr_v else None
    if a_u is None and a_v is None:
        return False

    n_verts = len(me.vertices)
    vals_u = [0.0] * n_verts
    vals_v = [0.0] * n_verts
    if a_u is not None and len(a_u.data) == n_verts:
        a_u.data.foreach_get("value", vals_u)
    if a_v is not None and len(a_v.data) == n_verts:
        a_v.data.foreach_get("value", vals_v)

    uv_data = uv_sd.data
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv_data[li].uv = (float(vals_u[vi]), 1.0 - float(vals_v[vi]))
    me.update()
    return True


packed = 0
for obj in bpy.data.objects:
    if obj.type != "MESH" or obj.hide_render:
        continue
    me = obj.data
    if obj.name == "ENV_Island_Top":
        if pack_sd_data(obj, "path", "_v4_soil"):
            packed += 1
    elif "_v4_damp" in me.attributes:
        if pack_sd_data(obj, "_v4_damp", None):
            packed += 1
    elif "tint" in me.attributes:
        if pack_sd_data(obj, "tint", None):
            packed += 1
    elif "TX_Curvature" in me.attributes:
        if pack_sd_data(obj, "TX_Curvature", None):
            packed += 1
print(f"Packed SD_DATA UV1 on {packed} meshes")


# 5. Rebuild and sculpt a cohesive, 360-degree floating-island underside:
#    - Tuck ENV_Island_Top's flat bottom radial fan safely inside the rock core
#    - Add rear & flank rock buttresses + full 360 collar so rear underside is rich & grounded
#    - Seat floating chunks tightly into rock shoulders, voxel-remesh into one watertight hull,
#      sculpt geological strata ledges, and decimate cleanly for fast load
from mathutils.bvhtree import BVHTree


def build_lawn_bvh(top_obj):
    me = top_obj.data
    w = top_obj.matrix_world
    verts = [w @ v.co for v in me.vertices]
    # Only top grass faces (material_index == 0)
    faces = [list(p.vertices) for p in me.polygons if p.material_index == 0]
    if not faces:
        faces = [list(p.vertices) for p in me.polygons]
    return BVHTree.FromPolygons(verts, faces)


def clamp_point_below_lawn(p, lawn_bvh, min_clearance=0.52):
    hit, _, _, _ = lawn_bvh.ray_cast(Vector((p.x, p.y, 20.0)), Vector((0.0, 0.0, -1.0)))
    if hit is not None:
        max_z = hit.z - min_clearance
        if p.z > max_z:
            p.z = max_z
        return p
    # Outside the grass cap footprint: pull inward beneath the nearest grass rim and below it
    loc, _, _, _ = lawn_bvh.find_nearest(Vector((p.x, p.y, -1.2)))
    if loc is not None:
        center = Vector((0.0, 2.0, 0.0))
        to_loc = Vector((loc.x - center.x, loc.y - center.y, 0.0))
        r_loc = to_loc.length
        to_p = Vector((p.x - center.x, p.y - center.y, 0.0))
        r_p = to_p.length
        if r_p > 1e-4 and r_loc > 1.0:
            target_r = max(0.5, r_loc - 0.65)
            if r_p > target_r:
                to_p.normalize()
                p.x = center.x + to_p.x * target_r
                p.y = center.y + to_p.y * target_r
        if p.z > loc.z - min_clearance:
            p.z = loc.z - min_clearance
    return p


def make_lobe_object(name, stations, seed, mat, lawn_bvh=None):
    n_seg = 24
    bm = bmesh.new()
    rings = []
    for ji, (cx, cy, z, rx, ry) in enumerate(stations):
        ring = []
        for k in range(n_seg):
            a = 2.0 * math.pi * k / n_seg
            nval = noise.noise(Vector((math.cos(a) * 1.8, math.sin(a) * 1.8, ji * 0.65 + seed)))
            rad = 1.0 + 0.14 * math.sin(a * 3.0 + seed) + 0.08 * nval
            x = cx + rx * rad * math.cos(a)
            y = cy + ry * rad * math.sin(a)
            zz = z + 0.12 * math.sin(a * 2.0 + 0.7) + 0.06 * nval
            pt = Vector((x, y, zz))
            if lawn_bvh is not None:
                clamp_point_below_lawn(pt, lawn_bvh, min_clearance=0.58)
            ring.append(bm.verts.new(pt))
        rings.append(ring)
    for ji in range(len(rings) - 1):
        r0, r1 = rings[ji], rings[ji + 1]
        for k in range(n_seg):
            kn = (k + 1) % n_seg
            bm.faces.new((r0[k], r0[kn], r1[kn], r1[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat:
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def rebuild_island_underside():
    top = bpy.data.objects.get("ENV_Island_Top")
    lawn_bvh = build_lawn_bvh(top) if top and top.type == "MESH" else None

    if top and top.type == "MESH" and lawn_bvh is not None:
        # Retract only the flat bottom radial fan (material index 1 inner vertices) safely
        # between grass cap (-0.35 below lawn) and the rock core below
        me_top = top.data
        w_top = top.matrix_world
        inv_top = w_top.inverted()
        soil_verts = {
            vi
            for p in me_top.polygons
            if p.material_index == 1
            for vi in p.vertices
        }
        for vi in soil_verts:
            wp = w_top @ me_top.vertices[vi].co
            dx = wp.x
            dy = (wp.y - 2.0) * 1.32
            r_ell = math.hypot(dx, dy)
            if r_ell < 11.5 and wp.z < -1.15:
                hit, _, _, _ = lawn_bvh.ray_cast(Vector((wp.x, wp.y, 20.0)), Vector((0.0, 0.0, -1.0)))
                safe_z = (hit.z - 0.35) if hit is not None else -1.05
                wp.z = min(-0.95, safe_z)
                me_top.vertices[vi].co = inv_top @ wp
        me_top.update()

    rock_mat = bpy.data.materials.get("SD_Rock_V4") or bpy.data.materials.get("SD_Rock")
    parts = []
    for o in list(bpy.data.objects):
        if o.type != "MESH" or o.hide_render:
            continue
        if (
            o.name.startswith("ENV_Island_Strata_")
            or o.name.startswith("V2_Rock_")
            or o.name == "ENV_Island_HangingMass"
        ):
            parts.append(o)
        elif o.name.startswith("ENV_Island_Chunk_"):
            # Seat chunks tightly inward & upward so zero spiky fragments float in air
            w = o.matrix_world
            center = w.translation.copy()
            center.x *= 0.78
            center.y = 2.0 + (center.y - 2.0) * 0.78
            center.z = min(-2.15, max(center.z + 0.95, -5.8))
            o.location = center
            o.scale = (1.12, 1.12, 0.76)
            parts.append(o)

    if not parts:
        return

    # Broad upper collar strictly tucked inside the grass skirt + 3 rear rock buttresses
    collar_stations = [
        (0.0, 2.0, -1.65, 13.4, 9.8),
        (-0.2, 1.9, -2.25, 12.8, 9.4),
        (-0.4, 1.8, -2.95, 11.4, 8.4),
        (-0.6, 1.6, -3.70, 9.0, 6.7),
    ]
    parts.append(make_lobe_object("_SD_Collar_Core", collar_stations, 11.3, rock_mat, lawn_bvh))

    rear_specs = [
        ("_SD_Rear_Center", [
            (0.4, 6.0, -1.95, 7.6, 4.2),
            (0.4, 5.8, -2.65, 7.1, 3.9),
            (0.2, 5.2, -3.65, 5.7, 3.3),
            (0.0, 4.5, -4.90, 3.8, 2.4),
            (-0.4, 3.5, -6.15, 1.7, 1.3),
            (-0.8, 2.8, -6.95, 0.55, 0.5),
        ], 41.7),
        ("_SD_Rear_Left", [
            (-7.8, 4.7, -2.00, 4.9, 3.7),
            (-8.0, 4.5, -2.65, 4.5, 3.4),
            (-7.8, 4.0, -3.65, 3.5, 2.7),
            (-7.4, 3.4, -4.85, 2.0, 1.7),
            (-7.0, 2.9, -5.75, 0.65, 0.6),
        ], 73.1),
        ("_SD_Rear_Right", [
            (8.0, 4.5, -2.00, 5.0, 3.6),
            (8.2, 4.3, -2.65, 4.6, 3.3),
            (7.9, 3.7, -3.65, 3.5, 2.7),
            (7.5, 3.1, -4.90, 2.0, 1.7),
            (7.1, 2.6, -5.85, 0.6, 0.55),
        ], 99.4),
    ]
    for rname, stations, seed in rear_specs:
        parts.append(make_lobe_object(rname, stations, seed, rock_mat, lawn_bvh))

    # Join all underside pieces into one mesh and apply transforms
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    hull = bpy.context.view_layer.objects.active
    hull.name = "ENV_Island_Underside"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Ensure no pre-remesh component extends above or outside the grass cap
    if lawn_bvh is not None:
        bm_pre = bmesh.new()
        bm_pre.from_mesh(hull.data)
        for v in bm_pre.verts:
            clamp_point_below_lawn(v.co, lawn_bvh, min_clearance=0.52)
        bm_pre.to_mesh(hull.data)
        bm_pre.free()

    # Voxel remesh into a single watertight hull with zero radial spokes or floating shards
    rem = hull.modifiers.new(name="VoxelHull", type="REMESH")
    rem.mode = "VOXEL"
    rem.voxel_size = 0.28
    rem.adaptivity = 0.0
    rem.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=rem.name)

    # Sculpt organic horizontal geological strata shelves & cliff crags on the unified hull
    bm = bmesh.new()
    bm.from_mesh(hull.data)
    for v in bm.verts:
        p = v.co
        depth_weight = max(0.0, min(1.0, (-1.65 - p.z) / 1.4))
        radial_dir = Vector((p.x, p.y - 2.0, 0.0))
        if radial_dir.length > 1e-4:
            radial_dir.normalize()
        n_broad = noise.noise(p * 0.24 + Vector((3.1, 7.4, 1.9)))
        n_fine = noise.noise(p * 0.68 + Vector((11.2, 4.7, 8.3)))
        strata_step = math.sin(p.z * 3.1 + n_broad * 2.1)
        outward = depth_weight * (0.30 * strata_step + 0.36 * n_broad + 0.16 * n_fine)
        v.co.x += radial_dir.x * outward
        v.co.y += radial_dir.y * outward
        v.co.z += depth_weight * (0.14 * n_fine - 0.07 * strata_step)
        if lawn_bvh is not None:
            clamp_point_below_lawn(v.co, lawn_bvh, min_clearance=0.52)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(hull.data)
    bm.free()

    # Decimate to clean web budget (~7-9k tris) while preserving strata silhouettes
    dec = hull.modifiers.new(name="UndersideDecimate", type="DECIMATE")
    dec.ratio = 0.30
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec.name)

    # Final safety clamp after decimation so zero triangles poke through lawn
    if lawn_bvh is not None:
        bm_post = bmesh.new()
        bm_post.from_mesh(hull.data)
        for v in bm_post.verts:
            clamp_point_below_lawn(v.co, lawn_bvh, min_clearance=0.52)
        bmesh.ops.recalc_face_normals(bm_post, faces=bm_post.faces[:])
        bm_post.to_mesh(hull.data)
        bm_post.free()

    # Single clean rock/soil-blended material + packed SD_DATA UV1 (u = soil collar mask)
    hull.data.materials.clear()
    if rock_mat:
        hull.data.materials.append(rock_mat)
    for poly in hull.data.polygons:
        poly.material_index = 0
        poly.use_smooth = True

    ensure_uvs(hull)
    uv_main = hull.data.uv_layers[0]
    uv_sd = hull.data.uv_layers["SD_DATA"]
    me_h = hull.data
    for poly in me_h.polygons:
        for li in poly.loop_indices:
            vi = me_h.loops[li].vertex_index
            co = me_h.vertices[vi].co
            uv_main.data[li].uv = (co.x * 0.12, co.z * 0.12)
            soil_mix = max(0.0, min(1.0, (co.z - (-3.0)) / 1.45))
            uv_sd.data[li].uv = (soil_mix, 1.0)
    me_h.update()
    print(f"Rebuilt ENV_Island_Underside: {len(me_h.vertices)} verts, {len(me_h.polygons)} tris")


rebuild_island_underside()

# 6. Decimate hyper-dense vegetation, stems, tower & island cap (preserves packed SD_DATA UVs)
DECIMATE_RATIOS = {
    "ENV_Tower_Shell": 0.36,
    "ENV_Island_Top": 0.40,
    "VEG_Hydrangea_": 0.20,
    "VEG_Shrub_": 0.28,
    "VEG_Ivy_Tower": 0.16,
    "VEG_Ivy_Hanging": 0.22,
    "VEG_Tree_Leaves": 0.34,
    "VEG_Tree_Wood": 0.28,
    "PRP_TV": 0.68,
    "PRP_CRT": 0.72,
    "PRP_Boombox": 0.72,
    "PRP_PCTower": 0.72,
    "PRP_DesktopCase": 0.72,
    "ENV_Cloud_": 0.14,
}


def decimate_object(obj, ratio):
    if obj.type != "MESH" or len(obj.data.polygons) < 300:
        return
    mod = obj.modifiers.new(name="WebDecimate", type="DECIMATE")
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


decimated_count = 0
for o in list(bpy.data.objects):
    if o.type != "MESH" or o.hide_render:
        continue
    if o.name.endswith("_Stems"):
        decimate_object(o, 0.08)
        decimated_count += 1
        continue
    for prefix, ratio in DECIMATE_RATIOS.items():
        if o.name.startswith(prefix):
            decimate_object(o, ratio)
            decimated_count += 1
            break
print(f"Decimated {decimated_count} dense meshes")


# 7. Join repetitive static objects so draw calls and GLTF node count drop
def join_group(objs, new_name):
    valid = [o for o in objs if o and o.type == "MESH" and not o.hide_render and len(o.data.polygons) > 0]
    if len(valid) <= 1:
        return valid[0] if valid else None
    for o in valid:
        ensure_uvs(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in valid:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = valid[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = new_name
    return joined


win_objs = [o for o in bpy.data.objects if o.name.startswith("ENV_Win_") and o.type == "MESH" and not o.hide_render]
merged_wins = join_group(win_objs, "ENV_Windows_Merged")
if merged_wins:
    decimate_object(merged_wins, 0.46)

stem_objs = [o for o in bpy.data.objects if o.name.endswith("_Stems") and o.type == "MESH"]
join_group(stem_objs, "VEG_Stems_Merged")

shrub_objs = [o for o in bpy.data.objects if o.name.startswith("VEG_Shrub_") and not o.name.endswith("_Stems") and o.type == "MESH"]
join_group(shrub_objs, "VEG_Shrubs_Merged")

hyd_objs = [o for o in bpy.data.objects if o.name.startswith("VEG_Hydrangea_") and o.type == "MESH"]
join_group(hyd_objs, "VEG_Hydrangeas_Merged")

cloud_col = bpy.data.collections.get("ENV_Sky")
cloud_objs = [o for o in (cloud_col.objects if cloud_col else []) if o.type == "MESH"]
if not cloud_objs:
    cloud_objs = [o for o in bpy.data.objects if o.name.startswith("ENV_Cloud") and o.type == "MESH"]
merged_clouds = join_group(cloud_objs, "ENV_Clouds_Merged")

# 8. Export metadata (cameras, lights, orbit rig)
scene = bpy.context.scene
scene.frame_set(1)
bpy.context.view_layer.update()

cameras = []
for o in sorted(bpy.data.objects, key=lambda x: x.name):
    if o.type != "CAMERA":
        continue
    mw = o.matrix_world
    pos = to_three_vec(mw.translation)
    fwd = to_three_dir(mw, (0.0, 0.0, -1.0))
    quat = to_three_quat(mw)
    lens = float(o.data.lens)
    sensor_w = float(o.data.sensor_width)
    t_prop = o.get("target")
    if t_prop is not None and len(t_prop) == 3:
        target = to_three_vec(t_prop)
    else:
        p0 = mw.translation
        d0 = (mw.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        center_b = Vector((0.0, 2.5, 4.0))
        dist = max(4.0, (center_b - p0).dot(d0))
        target = to_three_vec(p0 + d0 * dist)

    sensor_h_43 = sensor_w * (3.0 / 4.0)
    fov_43 = math.degrees(2.0 * math.atan(sensor_h_43 / (2.0 * lens)))
    cameras.append({
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

lights = []
for o in sorted(bpy.data.objects, key=lambda x: x.name):
    if o.type != "LIGHT":
        continue
    mw = o.matrix_world
    ld = o.data
    lights.append({
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

ctrl_orbit = bpy.data.objects.get("CTRL_orbit")
ctrl_target = bpy.data.objects.get("CTRL_orbit_target")
cam_orbit = bpy.data.objects.get("CAM_orbit")
orbit_info = {
    "center": to_three_vec(ctrl_orbit.matrix_world.translation) if ctrl_orbit else [0.0, 0.0, -3.5],
    "target": to_three_vec(ctrl_target.matrix_world.translation) if ctrl_target else [0.0, 4.3, -3.5],
    "cameraPos": to_three_vec(cam_orbit.matrix_world.translation) if cam_orbit else [2.68, 9.0, 57.94],
    "lensMm": float(cam_orbit.data.lens) if cam_orbit else 42.0,
}

meta = {
    "source": "SILICON_V1.0.blend",
    "viewTransform": scene.view_settings.view_transform,
    "look": scene.view_settings.look,
    "exposure": round(float(scene.view_settings.exposure), 4),
    "cameras": cameras,
    "lights": lights,
    "orbit": orbit_info,
}
with open(OUT_META, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)
print(f"Wrote {OUT_META}: {len(cameras)} cameras, {len(lights)} lights")

# 9. Export optimized main scene GLB
bpy.ops.object.select_all(action="DESELECT")
main_count = 0
for o in bpy.data.objects:
    if o.type != "MESH" or o.hide_render:
        continue
    if o == merged_clouds or o.name.startswith("ENV_Cloud"):
        continue
    if o.name.startswith("BLK_") or "Cutter" in o.name or o.name == "V3_Slab_End_Erosion":
        continue
    o.hide_set(False)
    o.select_set(True)
    main_count += 1

main_glb = os.path.join(OUT_MODELS, "silicon-dreams-v1.glb")
bpy.ops.export_scene.gltf(
    filepath=main_glb,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_attributes=False,
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_gn_mesh=True,
    export_gpu_instances=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=14,
)
print(f"Exported optimized main GLB ({main_count} objects): {os.path.getsize(main_glb):,} bytes")

# 10. Export merged clouds GLB
bpy.ops.object.select_all(action="DESELECT")
if merged_clouds:
    merged_clouds.hide_set(False)
    merged_clouds.select_set(True)

clouds_glb = os.path.join(OUT_MODELS, "clouds-v1.glb")
bpy.ops.export_scene.gltf(
    filepath=clouds_glb,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_texcoords=False,
    export_normals=True,
    export_materials="NONE",
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
)
print(f"Exported optimized clouds GLB: {os.path.getsize(clouds_glb):,} bytes")

