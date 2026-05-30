"""Tessellate a STEP B-rep into a triangle mesh for OpenSCAD's polyhedron().

Reads a STEP file via OCP, runs the OpenCASCADE incremental mesher over every
face, and writes a JSON {"points": [[x,y,z]...], "faces": [[i,j,k]...]} to
``out_json_path``. Vertices on shared edges are merged across faces so the
resulting polyhedron is watertight (a hard requirement for OpenSCAD CSG).

Usage: python step_to_mesh.py input.step output.json [linear_deflection]

linear_deflection (mm) controls tessellation smoothness; smaller = more
triangles. Defaults to 0.1 mm — fine enough for typical machined parts.
"""
import json
import sys

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS


def main(step_path: str, out_path: str, deflection: float) -> int:
    reader = STEPControl_Reader()
    if reader.ReadFile(step_path) != IFSelect_RetDone:
        print(f"failed to read STEP: {step_path}", file=sys.stderr)
        return 2
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        print("STEP contained no usable shape", file=sys.stderr)
        return 3

    # angularDeflection 0.5 rad (~28°) and the supplied linear tolerance. Parallel
    # meshing keeps big assemblies tolerable.
    BRepMesh_IncrementalMesh(shape, deflection, False, 0.5, True).Perform()

    points: list[list[float]] = []
    faces: list[list[int]] = []
    key_to_idx: dict[tuple[int, int, int], int] = {}

    # Quantise to ~1µm so coincident vertices from neighbouring faces collapse.
    Q = 1_000_000

    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        topo_face = TopoDS.Face_s(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(topo_face, loc)
        if tri is None:
            exp.Next()
            continue
        trsf = loc.Transformation()
        # OpenCASCADE flips face triangle winding to match REVERSED orientation.
        reverse = topo_face.Orientation() == TopAbs_REVERSED

        # Map face-local node ids -> global point indices.
        n_nodes = tri.NbNodes()
        face_pts: list[int] = [0] * (n_nodes + 1)  # 1-indexed
        for i in range(1, n_nodes + 1):
            p = tri.Node(i)
            p.Transform(trsf)
            x, y, z = p.X(), p.Y(), p.Z()
            key = (int(round(x * Q)), int(round(y * Q)), int(round(z * Q)))
            idx = key_to_idx.get(key)
            if idx is None:
                idx = len(points)
                key_to_idx[key] = idx
                points.append([x, y, z])
            face_pts[i] = idx

        for i in range(1, tri.NbTriangles() + 1):
            t = tri.Triangle(i)
            a, b, c = t.Get()
            ia, ib, ic = face_pts[a], face_pts[b], face_pts[c]
            # Drop degenerate triangles (a stray dedup match can collapse one).
            if ia == ib or ib == ic or ia == ic:
                continue
            if reverse:
                faces.append([ia, ic, ib])
            else:
                faces.append([ia, ib, ic])
        exp.Next()

    if not faces:
        print("no triangles produced from STEP", file=sys.stderr)
        return 4

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"points": points, "faces": faces}, f)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: step_to_mesh.py input.step output.json [linear_deflection]", file=sys.stderr)
        sys.exit(1)
    defl = float(sys.argv[3]) if len(sys.argv) > 3 else 0.1
    sys.exit(main(sys.argv[1], sys.argv[2], defl))
