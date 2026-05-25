"""Convert a mesh STL into a STEP B-rep solid using OpenCASCADE (OCP).

Reads the triangle soup from the STL, sews the faces into a shell, builds a
solid, and merges coplanar faces (UnifySameDomain) so flat surfaces become
single faces — yielding a clean editable solid body for Fusion 360 / CAD.

Usage: python stl_to_step.py input.stl output.step
"""
import sys

from OCP.StlAPI import StlAPI_Reader
from OCP.TopoDS import TopoDS_Shape, TopoDS
from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing, BRepBuilderAPI_MakeSolid
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SHELL


def main(stl_path: str, step_path: str) -> int:
    mesh = TopoDS_Shape()
    reader = StlAPI_Reader()
    if not reader.Read(mesh, stl_path):
        print("failed to read STL", file=sys.stderr)
        return 2

    # Sew the individual triangle faces into shell(s).
    sewing = BRepBuilderAPI_Sewing(0.001)
    sewing.Add(mesh)
    sewing.Perform()
    sewn = sewing.SewedShape()

    # Build a solid from each shell.
    solid_builder = BRepBuilderAPI_MakeSolid()
    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    n_shells = 0
    while exp.More():
        solid_builder.Add(TopoDS.Shell_s(exp.Current()))
        n_shells += 1
        exp.Next()
    shape = solid_builder.Solid() if n_shells else sewn

    # Merge coplanar/cosurface faces so flat surfaces are single faces.
    unify = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
    unify.Build()
    shape = unify.Shape()

    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    if writer.Write(step_path) != IFSelect_RetDone:
        print("failed to write STEP", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: stl_to_step.py input.stl output.step", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1], sys.argv[2]))
