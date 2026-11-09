import json,sys
shots=open("shots.json",encoding="utf-8").read()
cells=[]
def md(s): cells.append(dict(cell_type="markdown",metadata={},source=s))
def code(s): cells.append(dict(cell_type="code",metadata={},execution_count=None,outputs=[],source=s))
md("""# Ahzab reel: free GPU pipeline (Kaggle)

Makes everything the reel needs from **free, open models**:

| Stage | Model | Licence |
|---|---|---|
| A. Portrait of CHR-027 (4 candidates) | FLUX.1 Kontext [dev], 4-bit | FLUX.1 [dev] **non-commercial** licence |
| B. First frame of every shot, from the approved portrait | FLUX.1 Kontext [dev] | same |
| C. Image-to-video shots (breath, blinks, eye darts, expression) | LTX-Video 0.9.7 distilled | LTX-Video open weights licence |
| D. Arabic narration | Microsoft Edge neural voice `ar-SA-HamedNeural` via `edge-tts` | free, unofficial route |

**Settings before you run** (right-hand panel): Accelerator **GPU T4 x2** (two GPUs are needed), Internet **On** (needs a phone-verified Kaggle account).
**Secret:** Add-ons → Secrets → `HF_TOKEN` = a Hugging Face read token, after you click *Agree* on https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev.

Run the cells top to bottom. The notebook **stops twice on purpose**: after the portraits (pick one) and after the first frames (check the face matches). Every stage skips files it already made, so re-running is safe.
When done, *Save Version → Save & Run All* is not needed: just download `ahzab_out.zip` from the Output panel and upload it to the repo at `reels/ghazwat-al-ahzab/reel2/incoming/`.""")
code("""!pip -q install -U "diffusers>=0.34" "transformers>=4.51" accelerate bitsandbytes sentencepiece protobuf edge-tts imageio imageio-ffmpeg""")
code("""import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, gc, math, zipfile, torch, numpy as np
from pathlib import Path
from PIL import Image
SHOTS = json.loads(r'''%s''')
OUT = Path('/kaggle/working/ahzab_out'); [ (OUT/d).mkdir(parents=True, exist_ok=True) for d in ['portraits','frames','shots','voice'] ]
assert torch.cuda.device_count() >= 2, 'Turn on GPU T4 x2 (two GPUs) in Settings > Accelerator'
RUN, ENC = 'cuda:0', 'cuda:1'   # big model runs on GPU 1, text reader on GPU 2
DT = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
print(torch.cuda.get_device_name(0), DT)
try:
    from kaggle_secrets import UserSecretsClient
    os.environ['HF_TOKEN'] = UserSecretsClient().get_secret('HF_TOKEN')
except Exception as e:
    print('No Kaggle secret HF_TOKEN found:', e)
from huggingface_hub import login; login(os.environ['HF_TOKEN'])
def sheet(paths, out, cols=4, w=270):
    ims=[Image.open(p).convert('RGB') for p in paths]; h=int(w*ims[0].height/ims[0].width)
    rows=math.ceil(len(ims)/cols); s=Image.new('RGB',(cols*w,rows*h),'black')
    for i,im in enumerate(ims): s.paste(im.resize((w,h)),((i%%cols)*w,(i//cols)*h))
    s.save(out); return s
def is_blank(img): return np.asarray(img).mean() < 4""" % shots)
md("## Stage A: portrait candidates")
code("""from diffusers import FluxKontextPipeline, FluxTransformer2DModel, BitsAndBytesConfig as DBnb
KONTEXT = 'black-forest-labs/FLUX.1-Kontext-dev'
# 1) read every prompt once with the big T5 text reader on GPU 2, keep the results, then free it
enc = FluxKontextPipeline.from_pretrained(KONTEXT, transformer=None, vae=None, torch_dtype=DT).to(ENC)
EMB = {}
with torch.no_grad():
    for k, p in [('portrait', SHOTS['portrait_prompt'])] + [(s['id'], s['frame_prompt']) for s in SHOTS['shots']]:
        pe, pooled, _ = enc.encode_prompt(prompt=p, prompt_2=None, device=ENC, max_sequence_length=512)
        EMB[k] = (pe.cpu(), pooled.cpu())
del enc; gc.collect(); torch.cuda.empty_cache()
# 2) the image model alone on GPU 1 (4-bit), no T5
tr = FluxTransformer2DModel.from_pretrained(KONTEXT, subfolder='transformer', torch_dtype=DT,
        quantization_config=DBnb(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=DT))
kpipe = FluxKontextPipeline.from_pretrained(KONTEXT, transformer=tr, text_encoder_2=None, tokenizer_2=None, torch_dtype=DT).to(RUN)
kpipe.vae.enable_tiling()
def kgen(key, **kw):
    pe, pooled = EMB[key]
    return kpipe(prompt_embeds=pe.to(RUN), pooled_prompt_embeds=pooled.to(RUN), **kw).images[0]
print('GPU 1 memory in use:', round(torch.cuda.memory_allocated(0)/1e9,1), 'GB')
paths=[]
for i in range(4):
    f = OUT/'portraits'/f'CHR-027_front_{i}.png'
    if not f.exists():
        img = kgen('portrait', height=1392, width=752, guidance_scale=3.5, num_inference_steps=28,
                   generator=torch.Generator('cpu').manual_seed(27000+i))
        if is_blank(img): print('candidate', i, 'came out blank')
        img.save(f)
    paths.append(f)
sheet(paths, OUT/'portraits'/'contact_sheet.png')""")
md("""## STOP 1: approve the portrait
Look at the four candidates above (also in `ahzab_out/portraits/`). Put the number of the one you approve below, then run on.
The face, scar, beard, head cloth and tunic of this picture become the lock for every shot.""")
code("""CHOSEN = None   # e.g. 2
assert CHOSEN is not None, 'Pick a portrait number first'
PORTRAIT = Image.open(OUT/'portraits'/f'CHR-027_front_{CHOSEN}.png').convert('RGB')
PORTRAIT.save(OUT/'portraits'/'CHR-027_APPROVED.png')""")
md("## Stage B: first frame of every shot")
code("""paths=[]
for s in SHOTS['shots']:
    f = OUT/'frames'/f"{s['id']}.png"
    if not f.exists():
        kw = dict(guidance_scale=2.5, num_inference_steps=28,
                  generator=torch.Generator('cpu').manual_seed(int(s['id'][1:])*101))
        if s['kind']=='char':
            img = kgen(s['id'], image=PORTRAIT, **kw)
        else:
            img = kgen(s['id'], height=1392, width=752, **kw)
        if is_blank(img): print(s['id'], 'came out blank')
        img.save(f)
    paths.append(f)
sheet(paths, OUT/'frames'/'contact_sheet.png', cols=5)""")
md("""## STOP 2: check the frames
Every character frame must show **the same man** as the approved portrait (scar through the left eyebrow, patch on the right shoulder, head-cloth tail on the left).
To redo one frame: delete its file in `ahzab_out/frames/`, change its seed or prompt in `SHOTS`, and re-run the cell above. Then run on.""")
code("""del kpipe, tr; gc.collect(); torch.cuda.empty_cache()""")
md("## Stage C: image-to-video shots")
code("""from diffusers import LTXConditionPipeline
from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
from diffusers.utils import export_to_video
LTX = 'Lightricks/LTX-Video-0.9.7-distilled'
# text reader on GPU 2, once
enc = LTXConditionPipeline.from_pretrained(LTX, transformer=None, vae=None, torch_dtype=DT).to(ENC)
VEMB = {}
with torch.no_grad():
    for s in SHOTS['shots']:
        pe, pm, _, _ = enc.encode_prompt(prompt=s['video_prompt'], do_classifier_free_guidance=False, device=ENC, max_sequence_length=256)
        VEMB[s['id']] = (pe.cpu(), pm.cpu())
del enc; gc.collect(); torch.cuda.empty_cache()
vpipe = LTXConditionPipeline.from_pretrained(LTX, text_encoder=None, tokenizer=None, torch_dtype=DT).to(RUN)
vpipe.vae.enable_tiling()
W, H, FPS = 480, 832, 24
for s in SHOTS['shots']:
    f = OUT/'shots'/f"{s['id']}.mp4"
    if f.exists(): continue
    n = int(math.ceil(s['dur']*FPS/8))*8+1          # LTX wants 8k+1 frames
    img = Image.open(OUT/'frames'/f"{s['id']}.png").convert('RGB').resize((W,H), Image.LANCZOS)
    pe, pm = VEMB[s['id']]
    frames = vpipe(conditions=[LTXVideoCondition(image=img, frame_index=0)],
                   prompt_embeds=pe.to(RUN), prompt_attention_mask=pm.to(RUN), width=W, height=H,
                   num_frames=n, frame_rate=FPS, num_inference_steps=8, guidance_scale=1.0, decode_timestep=0.05,
                   decode_noise_scale=0.025, image_cond_noise_scale=0.0,
                   generator=torch.Generator('cpu').manual_seed(int(s['id'][1:])*7)).frames[0]
    export_to_video(frames, str(f), fps=FPS); print('made', f.name, n, 'frames')
    gc.collect(); torch.cuda.empty_cache()""")
md("## Stage D: Arabic narration")
code("""import edge_tts
for n in SHOTS['narration']:
    f = OUT/'voice'/f"{n['id']}.mp3"
    if not f.exists():
        await edge_tts.Communicate(n['text'], SHOTS['narration_voice'], rate='-12%', pitch='-6Hz').save(str(f))
print(sorted(os.listdir(OUT/'voice')))""")
md("## Pack the results")
code("""z = Path('/kaggle/working/ahzab_out.zip')
with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as zf:
    for p in OUT.rglob('*'):
        if p.is_file(): zf.write(p, p.relative_to(OUT.parent))
print(z, round(z.stat().st_size/1e6,1), 'MB')""")
nb=dict(cells=cells,metadata=dict(kernelspec=dict(name="python3",display_name="Python 3",language="python"),language_info=dict(name="python")),nbformat=4,nbformat_minor=5)
for c in nb["cells"]: c["source"]=c["source"]
json.dump(nb,open("ahzab_free_pipeline.ipynb","w"),ensure_ascii=False,indent=1)
