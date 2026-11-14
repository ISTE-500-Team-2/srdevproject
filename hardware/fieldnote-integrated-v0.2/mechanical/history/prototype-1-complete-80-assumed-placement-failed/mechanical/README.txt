Fieldnote V17 printable PCB retention prototype
==============================================

This revision retains the original 68.1 x 50.5 x 10.0 mm exterior and 0.6 mm
floor. Four tapered PETG supports carry the PCB at z=1.65 mm. Four aligned
PETG lid keeper posts end at z=4.65 mm. Compliant pads preload the PCB onto
the supports rather than relying on a rigid clamp across PCB thickness
variation. Side and rear stops plus two broad front blocks locate the board;
the front blocks connect directly to the front wall for a short load path.
No battery is modeled. J2, J3 and J4 remain DNP for the USB-only first batch.

PRINTABLE FILES (all dimensions in millimeters)

  base-V17-PCB-retained-PETG.stl
    Print with the original exterior bottom on the bed. Includes four seats,
    eight locating stops, USB opening and green clip clearance corrections.

  lid-V17-PCB-retained-PETG.stl
    Already in the original V17 interior-up print orientation. Includes four
    tapered keeper posts and a matching USB lip relief. Do not add a second
    180-degree flip in the slicer unless deliberately choosing another pose.

  compliant-puck-TPU-prototype.stl
    Print FOUR in flexible TPU, open face on the bed. Each is 2.4 mm square,
    2.0 mm tall, with 0.45 mm walls and 0.30 mm roof; the roof spans only
    1.5 mm. This is an unvalidated compression specimen. A 2 mm silicone
    foam pad cut to the same contact size is an alternative, subject to the
    same compression, bulge and retention checks. Do not print it in PETG.

  lid-assembled-inspection.stl and pads-nominal-compressed-inspection.stl
    Inspection geometry in assembled coordinates. Do not print these.

EDITABLE SOURCE AND REGENERATION

  retention-parameters.json is the dimensional parameter file.
  design_retention.py generates boolean solid geometry and verifies it.
  render_preview.py renders the annotated plan/section PNG and SVG.
  ../simulation/simulate_mechanical.py supplies the native PCB component
  envelopes and invokes design_retention.generate(). It reads the current
  fieldnote.kicad_pcb for poses, so stale placement locks are not trusted.
  manufacturing/placement-clearance-dimensions.json supplies the independently
  sourced maximum full package/lead dimensions for all 80 fitted purchased refs.
  Native positions, rotations, exact MPNs and transformed manufacturer bounds
  must match before a prism is formed. Each prism contains both those maxima
  and any earlier larger conservative native graphics/height envelope.
  Every fitted purchased ref must have a prism. Native F.Fab lines, rectangles,
  polygons and other supported graphics are read; an unsupported primitive or
  missing fitted body fails the audit instead of silently skipping that ref.
  extract_native_geometry.py uses KiCad's pcbnew API to save native-geometry.json
  with actual placements, all pad rectangles, pad drills and via drills. It
  checks the solid audit's text-parser transforms against the full native
  pad/drill multiset. Native pad angles are absolute board angles.

From the fieldnote-integrated-v0.2 directory, in a Python environment with
numpy, trimesh, manifold3d and matplotlib:

  python simulation/simulate_mechanical.py
  python mechanical/render_preview.py

When refreshing evidence for an unchanged printable case, preserve its bytes:

  python simulation/simulate_mechanical.py --preserve-printable-stls

This performs the full collision sweep and regenerates the PCB-component
inspection envelope, while checking and preserving the case/pad STL files.

To refresh the native extraction with KiCad's Python/pcbnew environment:

  python mechanical/extract_native_geometry.py
  python simulation/verify_native_pads.py

The extraction and native pad reports pin the current board/metadata hashes
and reject inputs that change during the check. The pad validator also pins
all loaded footprint library hashes and compares exact native nanometers,
using nearest-nanometer conversion for expected decimal coordinates.

The Codex runtime used for the saved results is:
  PYTHONPATH=/private/tmp/fieldnote-sim-libs
  /Users/maximusregent/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3

The original Box_V17_BRACED_PETG.stl and Lid_V17_BRACED_PETG.stl are preserved
under references/. They are required to regenerate this mesh-based revision.
All source hashes, output STL hashes and dimensions are in retention-checks.json.

BOUNDED GEOMETRY RESULT

The solid audit checks 243 combinations: nine +/-0.2 mm X/Y poses, three PCB
thicknesses (1.44, 1.60, 1.76 mm), three support planes (1.55, 1.65, 1.75 mm),
and three keeper-tip planes (4.55, 4.65, 4.75 mm). All rigid solid intersections
with the proposed case are zero within a 1e-5 mm3 numerical threshold.
An additional 27 solid-envelope checks cover EVERY intermediate X/Y translation
inside the +/-0.2 mm square, at each sampled vertical stack. The unchanged
orthogonal PCB outline is expanded with mitered joins; each component prism is
expanded in X/Y. These continuous XY envelope checks also have zero collisions.

For the worst floor bound the complete interior floor is raised to z=0.70 mm
in the audit only. The printable floor is unchanged at 0.60 mm. A USB tail
0.78 mm below the PCB still has at least 0.07 mm clearance to the high floor;
clearance to the original nominal floor is at least 0.17 mm. These are design
budgets, not claims of achieved print accuracy or a large mechanical margin.

Each actual 2.4 mm contact footprint remains entirely on the board across the
pose allowance and clears native exposed pads and via drills. The larger
4.0 mm pad-bulge envelope also clears native pads, vias, components and case.
The left rear pad sits on solder mask above NFC copper, so RF tuning must
include the finished case and all pads. The right rear bulge can overhang the
PCB's narrow sliver while its contact face remains entirely on the board.

The compliant pad installed gap is 1.04--1.76 mm, requiring 12--48% compression
of a measured 2.0 mm free pad (including any adhesive). No elastic material law
is modeled. PASS_BOUNDED_GEOMETRY means prescribed shapes fit; it does not
establish retention force, spring return, buckling or compression set.

COMPONENT DIMENSIONS

height-envelope-sources.json records source documents and package/assembly
ceilings. Important corrected maximum heights are 2.55 mm for ESP32-C3-MINI-1
and 1.00 mm for PN532, before the explicit seating allowances. Coilcraft 0603LS
uses 1.12 mm package plus 0.16 mm optional solder allowance. C4/C6/C7 reserve
1.45 mm plus 0.10 mm assembly allowance for possible 22uF 0805 substitutions.
L3 uses the larger drawing bound: 1.63 mm including termination plus 0.10 mm
seating, for a 1.73 mm prism. Y1 covers 3.4 by 2.7 mm maxima, and both switches
cover the full 3.65 by 2.85 mm terminal envelope. Native graphics and exact
manufacturer maximum bounding prisms are used rather than vendor STEP solids.
The case sweep moves the complete PCB by its stated +/-0.2 mm XY allowance;
independent per-component placement/rotation variation is outside this case
audit and belongs to the separate manufacturing clearance review.

CASE CORRECTIONS

The USB base opening spans x=49.5--59.3, y=-0.1--1.1, z=1.5--7.1 mm. The lid
lip is cleared to y=1.8 mm over z=6.5--7.1 mm. The existing green optical relief
uses radius 1.9 mm at (12,8), z=3.3--4.5 mm. A shallow local clearance below the
green clip spans x=4.3--12.7, y=5.0--7.8, z=3.3--3.65 mm, removing the original
clip's lower 0.15 mm where the maximum PCB stack otherwise interferes. Case
strength and optical performance after these cuts have not been measured.

PRINT AND ASSEMBLY QUALIFICATION

PETG geometry has tapered, solid supports/keepers and requires no new support
material in the stated orientations. The original V17 features still need their
usual print setup. A 0.2 mm layer height and 0.4 mm nozzle are reasonable trial
settings; verify actual dimensions rather than trusting slicer nominal values.
The small TPU puck benefits from a 0.25--0.4 mm nozzle and accurate thin-wall
handling. If it cannot be printed consistently, use qualified silicone foam.

Before inserting an energized PCB, measure support height, coplanarity and
floor thickness. Accept only support seats at least z1.55 and floor no higher
than z0.70 at USB tails. Keepers must terminate within z4.55--4.75. Remove burrs
from seats and stops. Check the seated PCB for rocking and inspect solder/tails;
local board warpage and independent uneven seat heights are not simulated.

Test a pad to the minimum 1.04 mm gap and check spring return before fitting
four pads. Pad compression must stay within the 4.0 mm lateral envelope and
must not hit a solid internal stop. Attach pads to the keeper tips with a small
adhesive that is compatible with the chosen material; the measured free height
must include that adhesive. Insert the PCB vertically, verify all four seats
contact, then close the lid without forcing it or bending the PCB. The board
must remain seated during repeated plug insertion/removal without rattling.

This is a physically untested printable prototype. There is no USB force,
drop/impact, PETG creep, TPU fatigue, thermal, RF, ingress or optical load rating.
The widened USB aperture still requires checking the actual mating plug boot.
No fabrication, purchase or external sharing has been performed.
