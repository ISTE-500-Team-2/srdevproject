FIELDNOTE PN7160 v0.3 / V17 R2 RETENTION AUDIT

FINAL NATIVE-V3 BOUNDED GEOMETRY PASS; PHYSICAL REVIEW/HOLD

This directory belongs to the separate PN7160 variant. Only the corrected R2
case geometry and audit algorithms are reused from the PN532 v0.2 project.
No PN532 component fit report, inspection envelope STL, preview, native-pad
result or body PASS is copied into this variant. Earlier v03 preparation
sources are preserved in history/preparation-before-adoption. Every v0.2 artifact, original
case STL and failed-candidate history remains unchanged.

The final adopted package catalog covers 78 fitted purchased references / 42
MPNs. Both the native and separately assumed individual-placement screens pass:
243 sampled stacks + 27 continuous rigid envelopes + 27 continuous pad envelopes
each, with zero collision cases. Actual native/library pad geometry agrees for
all 99 footprints; the solid parser matches all 371 pads, 18 pad drills and 162
via drills. These results bind the saved-fill native-review-candidate-v3:
  PCB SHA256 16c767ce38c3ed0bdd8345fea9010f13027d1d3d23fdc06d10d02107cebbdd65
  metadata SHA256 e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa
No final body result uses the historical seed poses.

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
and manufacturing/v03-clearance-native-geometry-r3.json. Native poses, selections,
footprints, dimensions, seating heights, asymmetric origins and transforms are
checked against the source. Missing/duplicate fitted references fail the audit.
Source files are hash-pinned at the beginning and checked unchanged at the end.
Final dimensions SHA256:
  70ccf1e644796aff380eb8d9e8a31e30ebd9b95b54adff4c989d83f348149bcc
Adopted catalog: manufacturing/v03-package-catalog-final.json, SHA256:
  3583476875aabd47614af78a68b4da15f7fb9021a2d3392b22f0e0cac16c6724

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

CURRENT OUTPUTS FROM ACTUAL FREEZE

Fresh printable geometry names are separate from every v0.2 export:
  base-V17-PCB-retained-PETG-pn7160-r2.stl
  lid-V17-PCB-retained-PETG-pn7160-r2.stl (interior-up on print bed)
  compliant-puck-TPU-prototype-pn7160-r2.stl (print four, qualify first)
Inspection-only, not printable assembly meshes:
  lid-assembled-inspection-pn7160-r2.stl
  pads-nominal-compressed-inspection-pn7160-r2.stl
  ../simulation/results/pcb-component-envelopes.stl
Continuous minimum positive component/tail gaps (mm):
                    base      lid       pad bulge
  Native            0.070     0.180     0.254951
  Assumed           0.070     0.118429  0.038084
The limiting base features are six J1 shell tails. J1 limits the lid gap. R5 at
contact2 limits the native pad gap; the ESP32 U1 module at contact4 limits the
assumed pad gap. The 0.0381 mm U1/pad margin is small and needs first-article
placement and pad-bulge measurement before production acceptance. The 2.4 mm
contact sweeps remain entirely on PCB; the conservative 4.0 mm bulge envelope
may overhang PCB at contacts2/4. Those overhangs have no prescribed solid case
collision but do not establish real elastomer behavior.

Gaps are exact minimum mesh distances for all 27 continuous full XY envelopes.
Intentional PCB/support/pad/keeper touch is excluded. Positive means separated,
zero means boundary touch. Interference is given negative sign with its solid
intersection volume; no numerical penetration depth is invented. The query
search ceiling is 8 mm. clearance-limiting-features.json independently assigns
the existing minima to full component/tail prisms, within 1e-6 mm.

Reports: retention-checks.json, ../simulation/results/mechanical.json,
native-geometry.json, ../simulation/results/native-pad-transform.json,
retention-preview.png/svg, clearance-limiting-features.json and freeze-refresh.json
with exact source/artifact hashes. A final preview must be visually inspected before final acceptance.

RUN AFTER OWNER ADOPTION AND FINAL DIMENSIONS

From the PN7160 project root, use KiCad's Python/pcbnew for:
  mechanical/extract_native_geometry.py
  simulation/verify_native_pads.py
These read native integer-nanometer geometry without saving CAD; the validator
compares the exact complete pad multiset against the loaded libraries.

Use the simulation Python environment (trimesh/manifold3d/numpy) for:
  simulation/simulate_mechanical.py
  mechanical/review_limiting_clearances.py
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
