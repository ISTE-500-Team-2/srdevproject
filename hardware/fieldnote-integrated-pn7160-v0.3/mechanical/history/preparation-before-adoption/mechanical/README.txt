FIELDNOTE PN7160 v0.3 / V17 R2 RETENTION AUDIT

PREPARED; FINAL PN7160 FIT NOT RUN

This directory belongs to the separate PN7160 variant. Only the corrected R2
case geometry and audit algorithms are reused from the PN532 v0.2 project.
No PN532 component fit report, inspection envelope STL, preview, native-pad
result or body PASS is copied into this variant. Every v0.2 artifact, original
case STL and failed-candidate history remains unchanged.

The package catalog currently covers 78 fitted purchased references / 41 MPNs.
Routing and final native placement are not yet adopted. The runners require an
explicit owner-adopted freeze before writing any fit report or inspection STL.
The catalog is a source/specification preparation artifact; its historical seed
poses are not final placement evidence.

INPUTS AND ADOPTION

mechanical/native-freeze.json must be created only after the hardware owner
explicitly supplies the adopted board/design/source revision. Required fields:
  status: OWNER_ADOPTED_NATIVE_FREEZE
  variant: PN7160_v03
  owner_authorization: record of the owner's explicit adoption
  source_sha256: exact relative paths and SHA-256 hashes, including at least
    fieldnote.kicad_pcb and design-data.json, plus other supplied freeze inputs.

The final all-78 manufacturer source is separately named:
  manufacturing/v03-placement-clearance-dimensions.json
It must match the adopted PCB and metadata hashes, accepted package catalog,
and manufacturing/v03-clearance-native-geometry.json. Native poses, selections,
footprints, dimensions, seating heights, asymmetric origins and transforms are
checked against the source. Missing/duplicate fitted references fail the audit.
Source files are hash-pinned at the beginning and checked unchanged at the end.

R2 CASE GEOMETRY

Exterior: 68.1 x 50.5 x 10 mm. Original 0.6 mm floor is retained; no thinning.
PCB registration: native origin [60,50] mm, case offset [1.3,3.8] mm.
Board thickness: 1.60 mm +/-10%, yielding 1.44..1.76 mm.
Support plane: 1.65 mm +/-0.10 mm. Keeper tip: 4.65 mm +/-0.10 mm.
Support/keeper centers, board-local mm:
  [4,7], [60.2,1.5], [4,42], [64,41.5]
Contact square: 2.4 mm; prescribed compliant-pad bulge bound: 4.0 mm square.
USB base opening: x49.3..59.5, y-0.1..1.1, z1.5..7.1 mm.
Lid USB lip relief: x49.3..59.5, y-0.1..1.8, z6.5..7.1 mm.
Green clip relief and shallow PCB-plane relief are parameterized separately.
USB-only first batch: J2/J3/J4 DNP; no battery, cable or mating plug modeled.

Four solid tapered PETG seats and four aligned lid keeper posts share positive
volume with their original case meshes. Locator tabs restrain lateral travel.
Each generated PETG base/lid must be watertight, winding-consistent, positive
volume and one connected solid. Exterior escape and original-floor removal
must be zero. Parameters remain editable in retention-parameters.json.

The installed pad gap spans 1.04..1.76 mm, requiring 12..48% compression from a
nominal 2.0 mm free-height pad. The hollow TPU puck is a prototype, not a proven
material specification. Its 0.45 mm walls and 0.30 mm roof require print and
compression qualification. Cut 2 mm silicone foam is an alternative candidate
with the same qualification requirement. Rigid PETG pads cannot accommodate
the tolerance stack. Pad force, elasticity, buckling and compression set are
not modeled; the prescribed 4 mm square bulge is an assumed geometry bound.

NEW PN7160 ENVELOPES

All final bodies include full manufacturer package/lead maxima and separate
stated seating allowances, unioned with native F.Fab geometry when present.
Native SOT pad/courtyard rectangles conservatively include soldered leads.
Manufacturer maxima are transformed using actual native centers/rotations.
The PN7160 package is SOT618-1, not the historical SOT618-16 spelling.

The accepted catalog contains these new assembled height bounds:
  U2 PN7160: 6.25 mm square, 1.10 mm including seating.
  Y1 NDK: 2.10 x 1.70 mm, 0.60 mm including seating.
  L1/L2 Murata: 1.75 x 0.95 mm, 1.05 mm including seating.
  C15..C18 Samsung: 1.70 x 0.90 mm, 1.00 mm including seating.
Other exact MPN dimensions come from the per-MPN height source and final
per-reference dimensions. No old PN532 U2/Y1/L1/L2 height table is reused.

J1 retains the reviewed exact HRO base-M12 registration and contact distinction:
  body local rectangle: [-4.57,-3.97]..[4.57,3.83] mm
  full body/contact rectangle: [-4.57,-4.47]..[4.57,3.83] mm
  full local center: [0,-0.32] mm; size: 9.14 x 8.30 mm
  assembled height: 3.36 + 0.05 = 3.41 mm
The full body/contact XY rectangle is conservatively extruded to full height.
The individual rotation radius is measured about the native footprint origin,
using its farthest local corner, not about the asymmetric rectangle center.
Radius 6.392636388846155 mm yields 0.21157113675092587 mm per-axis inflation
for +/-0.10 mm translation combined with +/-1 degree rotation. Native J1 shell
through-hole tails retain the 0.78 mm below-PCB bound. Against the allowed
0.70 mm upward-error floor, the stack has 0.07 mm minimum tail/floor clearance.

TWO SEPARATE COLLISION SCREENS

Native component poses plus whole-PCB pose:
  243 sampled stacks: 9 PCB XY poses x 3 thicknesses x 3 seat heights x 3
  keeper heights. Whole-PCB XY budget is +/-0.20 mm independently per axis.
  27 continuous whole-PCB XY envelope checks, one per vertical stack.
  27 continuous pad-bulge/component envelope checks, one per vertical stack.
Every intermediate XY translation is included by rectangular prism expansion
and the mitered offset of the orthogonal PCB outline. Rigid base/lid collision
and pad/component collision are reported separately. Native exposed pad and
via-drill sweeps are checked for the 2.4 mm contact and 4.0 mm bulge. Contact
sweeps must remain entirely on the PCB. Masked copper is permitted beneath a
contact; complete-case RF tuning must account for dielectric loading.

Assumed individual component placement plus whole-PCB pose:
  The same 243 sampled, 27 continuous rigid, and 27 continuous pad checks,
  with each full component prism additionally inflated in XY by
    0.10 mm + 2 * maximum native-origin corner radius * sin(0.5 degrees).
  Component height/seating bounds are retained. This includes simultaneous
  individual translation/rotation and whole-PCB translation.
These are assumed design/process budgets, not measured PCBWay placement
capability or measured printer tolerances. Failures must be reported to root
with exact refs/poses/geometry before any case revision or tolerance change.

EXPECTED OUTPUTS AFTER ACTUAL FREEZE

Fresh printable geometry names are separate from every v0.2 export:
  base-V17-PCB-retained-PETG-pn7160-r2.stl
  lid-V17-PCB-retained-PETG-pn7160-r2.stl (interior-up on print bed)
  compliant-puck-TPU-prototype-pn7160-r2.stl (print four, qualify first)
Inspection-only, not printable assembly meshes:
  lid-assembled-inspection-pn7160-r2.stl
  pads-nominal-compressed-inspection-pn7160-r2.stl
  ../simulation/results/pcb-component-envelopes.stl
Reports: retention-checks.json, ../simulation/results/mechanical.json,
native-geometry.json, ../simulation/results/native-pad-transform.json,
retention-preview.png/svg and freeze-refresh.json with exact source/artifact
hashes. A final preview must be visually inspected before final acceptance.

RUN AFTER OWNER ADOPTION AND FINAL DIMENSIONS

From the PN7160 project root, use KiCad's Python/pcbnew for:
  mechanical/extract_native_geometry.py
  simulation/verify_native_pads.py
These read native integer-nanometer geometry without saving CAD; the validator
compares the exact complete pad multiset against the loaded libraries.

Use the simulation Python environment (trimesh/manifold3d/numpy) for:
  simulation/simulate_mechanical.py
  mechanical/render_preview.py
  mechanical/finalize_report.py
Later fingerprint refreshes may pass --preserve-printable-stls to the mechanical
runner. Preservation requires unchanged parameters/source meshes/STL hashes.
All runs refuse unadopted/stale PCB or metadata. finalize_report.py refuses a
failed screen and requires both exact native extraction and pad verification.

PHYSICAL DISPOSITION

Engineering REVIEW/HOLD. Geometry passing does not establish supplied-part
registration, supplier assembly capability, printer accuracy, board warpage,
local solder bulges, PETG strength/creep/impact, retention or USB insertion force,
TPU/foam force/buckling/compression set, or actual USB plug/boot fit. Qualify the
printed seats and pads, assemble the actual board and plug, and verify RF in the
complete case. Reject support planes below z1.55 or floors above 0.70 mm unless
the USB-tail/floor bound is redesigned and audited. No production release,
upload, purchase or CAD modification is implied by these audit artifacts.
