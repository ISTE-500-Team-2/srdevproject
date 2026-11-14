"""Render a measured plan and a retention stack detail, not a photorealistic fit."""
from pathlib import Path
import json,sys,os
os.environ.setdefault('MPLCONFIGDIR','/private/tmp/fieldnote-mechanical-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, Rectangle, Circle
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import build_design as d
HERE=ROOT/'mechanical'
p=json.loads((HERE/'retention-parameters.json').read_text())
checks=json.loads((HERE/'retention-checks.json').read_text())
audit=json.loads((ROOT/'simulation/results/mechanical.json').read_text())
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False})
fig=plt.figure(figsize=(13.5,7.8),facecolor='#f5f4f0')
gs=fig.add_gridspec(1,2,width_ratios=(1.8,1),left=.07,right=.97,bottom=.16,top=.82,wspace=.23)
ax=fig.add_subplot(gs[0]); ax.set_facecolor('#faf9f6')
ax.add_patch(Rectangle((0,0),68.1,50.5,facecolor='#e4e1db',edgecolor='#78766f',linewidth=1.2))
outline=[(x+d.CASE_OFFSET[0],y+d.CASE_OFFSET[1]) for x,y in d.OUTLINE]
ax.add_patch(Polygon(outline,facecolor='#e8f1e8',edgecolor='#244c39',linewidth=1.4))
coil=[(x+d.CASE_OFFSET[0],y+d.CASE_OFFSET[1]) for x,y in d.COIL]
ax.plot(*zip(*coil),color='#659568',lw=2,alpha=.6)
for ref,(lo,hi) in audit['component_envelopes_mm'].items():
    ax.add_patch(Rectangle(lo[:2],hi[0]-lo[0],hi[1]-lo[1],facecolor='#8995a2',edgecolor='#546477',linewidth=.45,alpha=.58))
    if ref in ('U1','U2','J1'):
        ax.text((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,ref,ha='center',va='center',fontsize=9,color='#263642')
for i,(x,y) in enumerate(checks['contact_centers_case_mm'],1):
    w=p['pad_bulge_envelope_square_mm']
    ax.add_patch(Rectangle((x-w/2,y-w/2),w,w,fill=False,edgecolor='#ce7b26',lw=1.2,linestyle='--'))
    ax.add_patch(Circle((x,y),p['support_contact_radius_mm'],facecolor='#df9d36',edgecolor='#a1621b',lw=.8))
    ax.text(x,y,str(i),ha='center',va='center',fontsize=9,color='#30271a',fontweight='bold')
opening=p['usb_opening_bounds_mm']
ax.add_patch(Rectangle(opening[0][:2],opening[1][0]-opening[0][0],opening[1][1]-opening[0][1],facecolor='#ce7b26',alpha=.7))
ax.text(15,24,'NFC copper loop\nunder solder mask',ha='center',va='center',color='#406145',fontsize=10)
ax.text(55,46.3,'ESP32 antenna cutout',ha='center',va='center',fontsize=8,color='#546477')
ax.set_xlim(-1.7,70);ax.set_ylim(52.4,-4.5);ax.set_aspect('equal');ax.set_xlabel('Case x (mm)');ax.set_ylabel('Case y (mm)')
ax.set_title('Top view: four supports and aligned lid keepers',loc='left',fontsize=12,pad=13,fontweight='bold')
fig.text(.07,.07,'Orange discs: 2.4 mm contact  /  Dashed squares: 4.0 mm compliant-pad bulge bound',fontsize=9,color='#665d4f')

ax2=fig.add_subplot(gs[1]);ax2.set_facecolor('#faf9f6')
seat=p['board_bottom_nominal_mm'];top=seat+1.6;tip=p['keeper_tip_z_nominal_mm']
ax2.add_patch(Rectangle((-3,0),6,.6,facecolor='#9aa6b0'))
ax2.add_patch(Polygon([(-1.9,.5),(-1.2,seat),(1.2,seat),(1.9,.5)],facecolor='#719591',edgecolor='#345b58'))
ax2.add_patch(Rectangle((-3,seat),6,1.6,facecolor='#d8e9cf',edgecolor='#416039'))
ax2.add_patch(Rectangle((-1.2,top),2.4,tip-top,facecolor='#e2b26b',edgecolor='#a56d23',hatch='///'))
ax2.add_patch(Polygon([(-1.8,9.5),(-1.2,tip),(1.2,tip),(1.8,9.5)],facecolor='#719591',edgecolor='#345b58'))
ax2.add_patch(Rectangle((-3,9.4),6,.6,facecolor='#9aa6b0'))
for y,label in [(.3,'0.6 mm original floor'),(seat+.8,'PCB: 1.44–1.76 mm'),((top+tip)/2,'Compliant pad\ninstalled: 1.04–1.76 mm'),(6.8,'Rigid PETG keeper'),(9.7,'Original 0.6 mm roof')]:
    ax2.annotate(label,(1.25,y),(3.8,y),fontsize=9,va='center',arrowprops={'arrowstyle':'-','color':'#77746d','lw':.7})
ax2.text(-2.9,11.1,'Seat z = %.2f ±0.10 mm\nKeeper tip z = %.2f ±0.10 mm'%(seat,tip),fontsize=10,color='#345b58')
ax2.set_xlim(-4,11);ax2.set_ylim(-.7,12);ax2.set_xticks([]);ax2.set_yticks(range(0,11,2));ax2.set_ylabel('Assembled z (mm)')
ax2.set_title('Section at any support',loc='left',fontsize=12,pad=13,fontweight='bold')
for spine in ax2.spines.values():spine.set_visible(False)
fig.text(.07,.935,'FIELDNOTE  /  V17 PCB RETENTION R2',fontsize=20,fontweight='bold',color='#24483a')
fig.text(.07,.895,'Printable PETG supports + lid keepers; compliant pads accommodate PCB thickness and print height.',fontsize=11,color='#536258')
fig.text(.07,.047,'Native component poses + PCB pose: %s  |  %d fitted prisms  |  %d stacks + %d XY + %d pad envelopes'%(checks['status'],checks['fitted_component_coverage']['modeled_count'],checks['stack_sweep_cases'],checks['continuous_XY_pose_envelope_cases'],checks['continuous_pad_bulge_envelope_cases']),fontsize=9,color='#4c6655')
assumed=checks['assumed_independent_component_placement']
note='case/pad interference found' if assumed['status'].startswith('FAIL') else 'zero case/pad collisions; physical strength and process capability untested'
fig.text(.07,.023,'Assumed independent component placement: %s  |  %s'%(assumed['status'],note),fontsize=9,color='#9b3e32' if assumed['status'].startswith('FAIL') else '#4c6655')
fig.savefig(HERE/'retention-preview.png',dpi=170)
fig.savefig(HERE/'retention-preview.svg')
