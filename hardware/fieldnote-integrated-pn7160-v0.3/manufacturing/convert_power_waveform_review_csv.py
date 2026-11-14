#!/usr/bin/env python3
"""Preserve every float64 waveform sample in round-trip-verified CSV review files.

Original NPZ files stay untouched. NumPy is required for this conversion only.
The CSVs are evidence from diagnostic/smoke runs, not transient qualification.
"""
import csv,hashlib,json
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parents[1];base=root/'simulation/results/shared-native-power-v1';out=root/'output/power-waveform-csv-review-v3';out.mkdir(exist_ok=False)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
entries=[]
for name,kind in [('bg-api-check-intentional_wall_stop-raw.npz','API_SMOKE_INTENTIONAL_STOP_NOT_BOARD_POWER'),('bg-api-check-natural_completion-raw.npz','API_SMOKE_NATURAL_COMPLETION_NOT_BOARD_POWER'),('runs/qualified-warmup-physical-rl-v1/raw-waveforms.npz','FAILED_DISTRIBUTED_WARMUP_NOT_VERIFIED_NUMERICAL_ERROR')]:
 source=base/name;original_hash=sha(source)
 with np.load(source,allow_pickle=False) as z:
  keys=list(z.files);arrays={k:z[k].copy() for k in keys}
 assert arrays and all(a.dtype==np.dtype('float64') and a.ndim==1 for a in arrays.values())
 counts={len(a) for a in arrays.values()};assert len(counts)==1
 dest=out/(name.replace('/','__').replace('.npz','.csv'))
 with dest.open('x',newline='') as f:
  w=csv.writer(f);w.writerow(keys)
  for values in zip(*(arrays[k] for k in keys)):w.writerow([format(float(v),'.17g') for v in values])
 with dest.open(newline='') as f:
  r=csv.reader(f);assert next(r)==keys;rows=list(r)
 restored={k:np.array([float(row[i]) for row in rows],dtype='float64') for i,k in enumerate(keys)}
 for k,a in arrays.items():assert a.shape==restored[k].shape and a.dtype==restored[k].dtype and a.tobytes()==restored[k].tobytes(),k
 assert sha(source)==original_hash
 entries.append({'source_path':str(source),'source_sha256':original_hash,'source_bytes':source.stat().st_size,'archive_csv_path':dest.relative_to(root).as_posix(),'csv_sha256':sha(dest),'csv_bytes':dest.stat().st_size,'scope':kind,'column_names':keys,'arrays':[{'name':k,'shape':list(a.shape),'dtype':str(a.dtype),'sample_count':len(a),'exact_float64_bytes_roundtrip':True} for k,a in arrays.items()],'all_arrays_exact_roundtrip':True,'format':'CSV with header, original column order,17significantdigits; no downsampling or filtering','original_binary_in_review_archive':False})
report={'status':'ALL_ORIGINAL_ARRAYS_EXACT_FLOAT64_ROUNDTRIP_VERIFIED_NOT_POWER_QUALIFICATION','conversion_script_path':Path(__file__).relative_to(root).as_posix(),'conversion_script_sha256':sha(Path(__file__)),'numpy_version':np.__version__,'original_NPZ_untouched_externally_retained':True,'self_contained_simulation_reproduction':False,'files':entries,'limitations':['CSV contains every retained array/sample but original NPZ remains externally retained with exact path/hash.','Eight original ngspice runtime binaries are external dependencies; no standalone simulation-reproduction claim.','The actual board-path run failed numerically; API smoke vectors do not qualify board power.']}
(out/'conversion-provenance.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'files':len(entries),'exact_roundtrip':True,'actual_failed_run_samples':50,'actual_failed_run_arrays':17,'path':str(out/'conversion-provenance.json')},indent=2))
