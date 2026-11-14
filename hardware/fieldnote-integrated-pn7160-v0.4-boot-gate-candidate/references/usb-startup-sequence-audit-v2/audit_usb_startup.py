#!/usr/bin/env python3
"""Read-only native-schematic and arithmetic audit. No solver or CAD writer."""
from pathlib import Path
import datetime, hashlib, json, math, re

OUT = Path(__file__).resolve().parent
PN = OUT.parents[2]
HW = PN.parent
SELECTED = {'U1','U3','U4','U6','U7','R1','R2','R6','R7','R12','R26',
            'C9','C32','C33','C36','SW1','SW2','J4'}

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def children(a,k): return [v for v in a[1:] if isinstance(v,list) and v and v[0]==k]
def child(a,k): return next(iter(children(a,k)),None)
def sexp(s):
    t=iter(re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+',s))
    def read(v):
        if v!='(': return json.loads(v) if v.startswith('"') else v
        a=[]
        for q in t:
            if q==')': return a
            a.append(read(q))
        raise ValueError('unclosed expression')
    a=read(next(t))
    assert next(t,None) is None
    return a
def key(x,y): return (round(float(x),6),round(float(y),6))

def native_sheet(path):
    d=sexp(path.read_text()); libraries={v[1]:v for v in children(child(d,'lib_symbols'),'symbol')}
    graph={}; labels={}; nc={}; result={}
    for w in children(d,'wire'):
        pts=[key(*v[1:3]) for v in children(child(w,'pts'),'xy')]
        assert len(pts)==2
        for a,b in [pts,pts[::-1]]: graph.setdefault(a,set()).add(b)
    for typ in ['label','global_label','hierarchical_label']:
        for lab in children(d,typ):
            xy=key(*child(lab,'at')[1:3]); labels.setdefault(xy,set()).add(lab[1])
    for v in children(d,'no_connect'): nc[key(*child(v,'at')[1:3])]=child(v,'uuid')[1]
    for s in children(d,'symbol'):
        props={v[1]:v[2] for v in children(s,'property')}; ref=props['Reference']
        if ref not in SELECTED: continue
        at=child(s,'at'); assert float(at[3])==0, 'audit intentionally rejects unhandled transforms'
        assert child(s,'mirror') is None
        lib=libraries[child(s,'lib_id')[1]]; pins={}
        for unit in children(lib,'symbol'):
            for pin in children(unit,'pin'):
                pa=child(pin,'at'); xy=key(float(at[1])+float(pa[1]),float(at[2])-float(pa[2]))
                seen={xy}; todo=[xy]; names=set()
                while todo:
                    pos=todo.pop(); names.update(labels.get(pos,set()))
                    for other in graph.get(pos,set()):
                        if other not in seen: seen.add(other); todo.append(other)
                assert len(names)<=1, (path,ref,xy,names)
                assert names or xy in nc, (path,ref,xy,'missing native label/no-connect')
                number=child(pin,'number')[1]
                pins[number]=dict(name=child(pin,'name')[1],net=next(iter(names),None),
                                  xy_mm=xy,wire_vertex_count=len(seen),no_connect=xy in nc)
        result[ref]=dict(value=props['Value'],MPN=props.get('MPN'),
                         instance_uuid=child(s,'uuid')[1],pins=pins,sheet=path.name)
    return result

def step_time(R,C,ratio): return -R*C*math.log1p(-ratio)
def main():
    sources=[]; rows={}; checks=[]
    for name in ['fieldnote-integrated-pn7160-v0.3','fieldnote-integrated-v0.2']:
        root=HW/name; paths=[root/'design-data.json',root/'usb-power.kicad_sch',root/'esp32-leds.kicad_sch']
        sources.extend(paths); before={str(p):sha(p) for p in paths}
        data=json.loads(paths[0].read_text()); parts={v['ref']:v for v in data['parts']}
        extracted={}
        for p in paths[1:]: extracted.update(native_sheet(p))
        for ref,n in extracted.items():
            m=parts[ref]
            checks.append(dict(board=name,ref=ref,check='value',pass_=n['value']==m['value']))
            for pin,v in n['pins'].items():
                checks.append(dict(board=name,ref=ref,pin=pin,check='native pin label versus design metadata',
                                   pass_=v['net']==m['nets'][pin]))
        rows[name]=dict(native_parts=extracted,read_inputs_unchanged=all(sha(Path(p))==h for p,h in before.items()))
    firmware={}
    for build in ['product-build','factory-build']:
        root=PN/'firmware-cpu80'/build
        cfg=root/'sdkconfig'; props=root/'build.options.json'; sources += [cfg,props]
        config=cfg.read_text()
        assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160' in config
        assert 'CPUFreq=80' in json.loads(props.read_text())['fqbn']
        firmware[build]=dict(sdk_cpu_MHz=160,arduino_fqbn=json.loads(props.read_text())['fqbn'])
    extra=[PN/'firmware-cpu80/product-build/app-main-disassembly.txt',
           PN/'firmware-cpu80/product-build/idf-clock-disassembly.txt',
           PN/'firmware-cpu80/factory-build/app-main-disassembly.txt',
           PN/'firmware-cpu80/product_integrated_pn7160_v03/integrated_power.h',
           PN/'firmware-cpu80/product_integrated_pn7160_v03/product_integrated_pn7160_v03.ino',
           PN/'firmware-cpu80/factory_test_pn7160_v03/factory_test_pn7160_v03.ino',
           PN/'simulation/results/shared-native-power-v1/code/simulate_network.py',
           PN/'manufacturing/usb100-startup-assumption-review.md',
           PN/'manufacturing/v03-clearance-sources/tusb320lai.pdf',
           PN/'references/power-review/bq24074.pdf',
           PN/'references/power-review/tps63031.pdf',
           PN/'simulation/startup-assumption-references/esp32-c3-mini-datasheet-v2.2.pdf',
           PN/'simulation/startup-assumption-references/idf-bootloader-clock.c',
           PN/'simulation/startup-assumption-references/idf-c3-clk.c',
           PN/'Fieldnote.pretty/SOT23-6.kicad_mod']
    sources += extra
    clocks=(PN/'firmware-cpu80/product-build/idf-clock-disassembly.txt').read_text()
    app=(PN/'firmware-cpu80/product-build/app-main-disassembly.txt').read_text()
    assert re.search(r'li\s+a0,160\b',clocks) and re.search(r'li\s+a0,80\b',app)
    model=(PN/'simulation/results/shared-native-power-v1/code/simulate_network.py').read_text()
    assert "lim=full_lim if staged or warmup else .087" in model
    assert 'high current is not dynamically negotiated' in model
    rc=[]
    for label,R,C in [('minimum_screen',47000*.99*.994,.4e-6),
                      ('nominal',47000,1e-6),('maximum_screen',47000*1.01*1.006,1.265e-6)]:
        rc.append(dict(case=label,R_ohm=R,C_F=C,
                       possible_release_after_step_ms=1e3*step_time(R,C,.25),
                       guaranteed_high_after_step_ms=1e3*step_time(R,C,.75)))
    tps=[]
    for label,R,C,V in [('minimum_screen',150000*.99*.994,.4e-6,4.5),
                        ('nominal',150000,1e-6,4.3),
                        ('maximum_screen',150000*1.01*1.006,1.265e-6,4.3)]:
        tps.append(dict(case=label,R_ohm=R,C_F=C,VSYS_step_V=V,
                        possible_on_after_step_ms=1e3*step_time(R,C,.4/V),
                        guaranteed_on_after_step_ms=1e3*step_time(R,C,1.2/V)))
    gate=dict(part='SN74LVC1G97DBVR',package='DBV 6-pin SOT-23',
              connections={'1':'GND','2':'GND','3':'ESP_RESET_RC','4':'ESP_CHIP_EN',
                           '5':'3V3','6':'POWER_PERMIT'},
              logic='CHIP_EN = RESET_RC && POWER_PERMIT',
              RC_node_contains=['R12.1','C9.1','SW1.1','SW1.2','J4.5','U8.3'],
              preferred_R12_high_side='R12.2 moved from3V3 toPOWER_PERMIT; all other RC/reset wiring remainsonRCinput',
              isolated_chip_EN_contains=['U1.8','U8.4','new47k pulldown'],
              power_permit_selector=dict(default='USB_HIGH_CURRENT',service='3V3',
                                         form='3-pad mutually exclusive solder selector; default NORMAL bridge',
                                         no_bridge='47k pulldown holds LOW under bothinputleakages'),
              fitted_additions=['U8 gate','local100nF decoupling','47k CHIP_EN pulldown','47k POWER_PERMIT pulldown'],
              existing_value_change='R2 100k -> 10k; maintain BQ EN2 pulldown on USB_HIGH_CURRENT',
              exact_passives={'new CHIP_EN47k':'RC0603FR-0747KL',
                              'new POWER_PERMIT47k':'RC0603FR-0747KL',
                              'new100nF':'CC0603KRX7R9BB104',
                              'R2replacement10k':'RC0603FR-0710KL',
                              'retainedR12':'RC0603FR-0747KL',
                              'retainedC9':'C0603C105K4RACTU'},
              land_pattern=dict(proposed_name='TI_DBV0006A',source='TI DBV0006Aexamplelayoutprintedp36',
                   centers_mm={'1':[-1.3,-.95],'2':[-1.3,0],'3':[-1.3,.95],
                               '4':[1.3,.95],'5':[1.3,0],'6':[1.3,-.95]},
                   copper_pad_mm=[1.1,.6],corner_radius_mm=.05,
                   note='New dedicatedfootprint preferred; existingSOT23-6is IPCalternategeometry, not identicalTIexample.'),
              leakage_screens=dict(poweroff_CHIP_EN_V=47e3*1.01*1.006*10.05e-6,
                                   poweroff_USB_HIGH_CURRENT_V=10e3*1.01*1.006*30e-6,
                                   unbridged_POWER_PERMIT_V=47e3*1.01*1.006*10e-6,
                                   superseded_unbridged_100k_POWER_PERMIT_V=100e3*1.01*1.006*10e-6,
                                   max_CHIP_EN_high_load_A=3.6/(47e3*.99*.994)+.05e-6,
                                   min_RC_steady_at_3V_V=2.4-47e3*1.01*1.006*5e-6,
                                   max_low_RC_steady_V=.1+47e3*1.01*1.006*5e-6),
              power_permit_100k_limitation='WithR12chargedfromPERMIT,bothinputleakagescanproduce1.016Vwhenunbridged; '
                'thisexceeds3VVT-minusminimum0.84VandcannotguaranteepreviouslyHIGHstatereturnsLOW. '
                '100kisacceptableonlywithselectorclosedandnoupoweredunbridgedfailsafeclaim.',
              cold_RC_step_at_3V_screen=dict(
                 earliest_ms=1e3*step_time(47000*.99*.994,.4e-6,
                     1.5/(3+47000*.99*.994*5e-6)),
                 latest_ms=1e3*step_time(47000*1.01*1.006,1.265e-6,
                     1.87/(2.4-47000*1.01*1.006*5e-6)),
                 limitation='C9 initiallyzero; valid3Vgate supply; permitstep2.4..3V; '
                            'threshold/dataat3Vtestpoint. Noarbitraryramp/full3.0..3.6Vinterpolationguarantee.'),
              scope='Static proposal only; no CAD edits, purchase quote, solver or hardware validation. '
                    'Shared-rail logic is specified only at valid supply; Ioff is a VCC=0 specification, '
                    'not a guarantee for every point of an arbitrary analog power ramp.')
    truth=[]
    for cc in [False,True]:
        for reset in [False,True]:
            for service in [False,True]:
                truth.append(dict(high_current=cc,reset_RC_high=reset,service_bridge=service,
                                  CHIP_EN=reset and (service or cc),
                                  BQ_resistor_mode=cc))
    result=dict(status='SEQUENCING_GAP_CONFIRMED_BOOT_FAILURE_NOT_PROVEN',
                captured_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                solver_runs=0,native=rows,checks=checks,checks_passed=sum(c['pass_'] for c in checks),
                checks_failed=sum(not c['pass_'] for c in checks),firmware=firmware,
                datasheet_timing=dict(TUSB320LAI_document='SLLSEQ8D Rev D May2017',
                    printed_page=6,CC_default_ms={'min':None,'typ':168,'max':None},
                    VBUS_debounce_ms={'min':None,'typ':2,'max':None},
                    I2C_ready_ms={'min':None,'typ':None,'max':100},
                    GPIO_attach_completion_max_ms=None,
                    VDD_ramp_requirement_max_ms=25,
                    EN_N_external_control_hold_low_min_ms=50,
                    EN_N_on_board='hardwired GND; no externally controlled reset delay added'),
                ESP_RC_ideal_step_screens=rc,TPS_RC_ideal_step_screens=tps,
                RC_scope='Arithmetic screens, not measured attach times. Excludes rail ramp, input leakage, '
                         'reset hysteresis, precharge, local return and regulator state. Capacitance range is '
                         'retained engineering screen, not manufacturer joint guarantee.',
                inference='No causal hardware ordering forces CC-qualified high current before ESP CHIP_EN. '
                          'Typical CC debounce exceeds every calculated ESP settled-step guaranteed-high delay. '
                          'No TI GPIO attach max or ESP complete boot-current max was found. '
                          'Brownout/livelock remains plausible; no actual hardware failure proved.',
                model_scope='USB100 BQ usable-path allowance87mA plus3mA explicit BQ overhead. '
                            'Cold/service decks retain87mA; warmup/full decks impose full allowance. '
                            'No dynamic TUSB/U7/BQ current-mode transition is represented.',
                hardware_proposal=gate,proposal_truth_table=truth,
                source_sha256={str(p.relative_to(HW.parent)):sha(p) for p in sources})
    assert result['checks_failed']==0 and all(x['read_inputs_unchanged'] for x in rows.values())
    (OUT/'usb-startup-audit.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(status=result['status'],native_checks_passed=result['checks_passed'],
                         native_checks_failed=result['checks_failed'],solver_runs=0,
                         ESP_RC_ideal_step_screens=rc,TPS_RC_ideal_step_screens=tps,
                         gate_leakage_screens=gate['leakage_screens']),indent=2))

if __name__=='__main__': main()
