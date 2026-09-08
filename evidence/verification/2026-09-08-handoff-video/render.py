from pathlib import Path
import json, subprocess, textwrap
root=Path('.scratch/hil-video-v2')
data=json.loads((root/'capture.json').read_text())
start=data['operatorStartedAt']
duration=(data['marks'][-1]['at']-start)/1000+5
shift=(start-data['applicationStartedAt'])/1000

def stamp(t):
 t=max(0,t); cent=round(t*100)
 return f'{cent//360000}:{cent//6000%60:02}:{cent//100%60:02}.{cent%100:02}'
header='''[Script Info]
ScriptType: v4.00+
PlayResX: 2000
PlayResY: 1080
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Arial,29,&H00FFFFFF,&H00FFFFFF,&H00221B12,&H00221B12,-1,0,0,0,100,100,0,0,1,0,0,8,20,20,7,1
Style: Label,Arial,22,&H00DDDDDD,&H00DDDDDD,&H00221B12,&H00221B12,0,0,0,0,100,100,0,0,1,0,0,8,20,20,44,1
Style: Caption,Arial,27,&H00FFFFFF,&H00FFFFFF,&H00221B12,&H00221B12,0,0,0,0,100,100,0,0,1,0,0,2,90,90,28,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
rows=[f'Dialogue: 0,0:00:00.00,{stamp(duration)},Title,,0,0,0,,Human handoff | Real Chromium session | Synthetic fixture | Scripted Operator',
 f'Dialogue: 0,0:00:00.00,{stamp(duration)},Label,,0,0,0,,{{\\pos(500,45)}}Application: the same session throughout',
 f'Dialogue: 0,0:00:00.00,{stamp(duration)},Label,,0,0,0,,{{\\pos(1500,45)}}Operator interface: ownership and recorded actions']
for i,mark in enumerate(data['marks']):
 end=(data['marks'][i+1]['at']-start)/1000 if i+1<len(data['marks']) else duration
 text='\\N'.join(textwrap.wrap(mark['text'],width=112))
 rows.append(f'Dialogue: 0,{stamp((mark["at"]-start)/1000)},{stamp(end)},Caption,,0,0,0,,{text}')
(root/'captions.ass').write_text(header+'\n'.join(rows)+'\n')
filters=f'[0:v]trim=start={shift},setpts=PTS-STARTPTS,fps=25,tpad=stop_mode=clone:stop_duration=10[a];[1:v]setpts=PTS-STARTPTS,fps=25,tpad=stop_mode=clone:stop_duration=10[b];[a][b]hstack=inputs=2,pad=2000:1080:0:80:color=0x121b22,ass={root}/captions.ass[out]'
subprocess.run(['ffmpeg','-hide_banner','-y','-i',data['applicationVideo'],'-i',data['operatorVideo'],'-filter_complex',filters,'-map','[out]','-t',str(duration),'-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(root/'human-handoff.mp4')],check=True)
(root/'render.json').write_text(json.dumps({'durationSeconds':duration,'applicationTrimSeconds':shift,'composition':'Two real browser recordings aligned to page-creation timestamps, at original speed. Added labels and event-derived captions. Final frames held for five seconds to read the verified result. No UI states fabricated.','file':'human-handoff.mp4'},indent=2)+'\n')
