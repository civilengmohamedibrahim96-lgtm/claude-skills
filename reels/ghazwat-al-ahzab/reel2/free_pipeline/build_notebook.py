import json,sys
shots=open("shots.json",encoding="utf-8").read()
cells=[]
def md(s): cells.append(dict(cell_type="markdown",metadata={},source=s))
def code(s): cells.append(dict(cell_type="code",metadata={},execution_count=None,outputs=[],source=s))
md("""# Ahzab reel: free GPU pipeline (Kaggle)

Makes everything the reel needs from **free, open models**:

| Stage | Model | Licence |
|---|---|---|
| A. Portrait of CHR-027 (3 candidates, ink style) | FLUX.1 Kontext [dev], 4-bit | FLUX.1 [dev] **non-commercial** licence |
| B. First frame of every shot, from the approved portrait | FLUX.1 Kontext [dev] | same |
| C. Image-to-video shots (breath, blinks, eye darts, expression) | LTX-Video 0.9.7 distilled | LTX-Video open weights licence |
| D. Arabic narration | Microsoft Edge neural voice `ar-SA-HamedNeural` via `edge-tts` | free, unofficial route |

**Settings before you run** (right-hand panel): Accelerator **GPU T4 x2** (two GPUs are needed), Internet **On** (needs a phone-verified Kaggle account).
**Secret:** Add-ons → Secrets → `HF_TOKEN` = a Hugging Face read token, after you click *Agree* on https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev.

Run the cells top to bottom. The notebook **stops three times on purpose**: pick a face, approve the re-dressed portrait, and check the first frames. Every stage skips files it already made, so re-running is safe.
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
from concurrent.futures import ThreadPoolExecutor
KONTEXT = 'black-forest-labs/FLUX.1-Kontext-dev'
STEPS, W, H = 20, 576, 1024          # 20 steps at 576x1024: about twice as fast as before
# 1) read every prompt once with the big T5 text reader, keep the results, then free it
enc = FluxKontextPipeline.from_pretrained(KONTEXT, transformer=None, vae=None, torch_dtype=DT).to(ENC)
EMB = {}
with torch.no_grad():
    for k, p in [('portrait', SHOTS['portrait_prompt']), ('edit', SHOTS['edit_prompt'])] + [(s['id'], s['frame_prompt']) for s in SHOTS['shots']]:
        pe, pooled, _ = enc.encode_prompt(prompt=p, prompt_2=None, device=ENC, max_sequence_length=512)
        EMB[k] = (pe.cpu(), pooled.cpu())
del enc; gc.collect(); torch.cuda.empty_cache()
# 2) one 4-bit image model on EACH GPU, so two pictures are made at the same time
def make_kpipe(dev):
    with torch.cuda.device(dev):
        tr = FluxTransformer2DModel.from_pretrained(KONTEXT, subfolder='transformer', torch_dtype=DT,
                quantization_config=DBnb(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=DT))
    p = FluxKontextPipeline.from_pretrained(KONTEXT, transformer=tr, text_encoder_2=None, tokenizer_2=None, torch_dtype=DT).to(dev)
    p.vae.enable_tiling(); p.set_progress_bar_config(disable=True)
    return p, dev
KP = [make_kpipe(RUN), make_kpipe(ENC)]
def kgen(gpu, key, **kw):
    p, dev = KP[gpu]; pe, pooled = EMB[key]
    return p(prompt_embeds=pe.to(dev), pooled_prompt_embeds=pooled.to(dev), height=H, width=W, max_area=W*H,
             num_inference_steps=STEPS, **kw).images[0]
def run_on_both(jobs):
    # jobs: list of (output_path, function(gpu) -> image); GPU 1 takes the even ones, GPU 2 the odd ones
    todo = [j for j in jobs if not j[0].exists()]
    def worker(gpu):
        for path, fn in todo[gpu::2]:
            img = fn(gpu)
            if is_blank(img): print(path.name, 'came out blank')
            img.save(path); print('made', path.name, flush=True)
    with ThreadPoolExecutor(2) as ex: list(ex.map(worker, [0, 1]))
import time; t = time.time()
paths = [OUT/'portraits'/f'CHR-027_v2_{i}.png' for i in range(3)]
run_on_both([(f, (lambda gpu, i=i: kgen(gpu, 'portrait', guidance_scale=3.5,
             generator=torch.Generator('cpu').manual_seed(27100+i)))) for i, f in enumerate(paths)])
print('minutes:', round((time.time()-t)/60, 1))
sheet(paths, OUT/'portraits'/'contact_sheet_v2.png', cols=3)""")
md("""## STOP 1: pick the face
Look at the three ink portraits above (numbered 0, 1, 2 from the left). Put the number of the **face** you like in `FACE` below and run on.
The next cell keeps that face and only changes his hair and clothes to 7th-century Hijaz (wool waist-wrap, patched camel-hair shawl, thin cloth tied around the forehead, rope coil). It makes three versions.""")
code("""FACE = None   # e.g. 1 for the middle one
assert FACE is not None, 'Pick a face number first'
base = Image.open(OUT/'portraits'/f'CHR-027_v2_{FACE}.png').convert('RGB').resize((W, H), Image.LANCZOS)
t = time.time()
paths = [OUT/'portraits'/f'CHR-027_v3_{i}.png' for i in range(3)]
run_on_both([(f, (lambda gpu, i=i: kgen(gpu, 'edit', image=base, _auto_resize=False, guidance_scale=2.5,
             generator=torch.Generator('cpu').manual_seed(27300+i)))) for i, f in enumerate(paths)])
print('minutes:', round((time.time()-t)/60, 1))
sheet([OUT/'portraits'/f'CHR-027_v2_{FACE}.png'] + paths, OUT/'portraits'/'contact_sheet_v3.png', cols=4)""")
md("""## STOP 2: approve the final portrait
The sheet above shows the original face first, then the three re-dressed versions (numbered 0, 1, 2 after the original).
Put the number of the one you approve in `CHOSEN`. Its face and clothes become the lock for every shot.""")
code("""CHOSEN = None   # e.g. 0
assert CHOSEN is not None, 'Pick the final portrait number first'
PORTRAIT = Image.open(OUT/'portraits'/f'CHR-027_v3_{CHOSEN}.png').convert('RGB').resize((W, H), Image.LANCZOS)
PORTRAIT.save(OUT/'portraits'/'CHR-027_APPROVED.png')""")
md("## Stage B: first frame of every shot")
code("""t = time.time()
def frame_job(s):
    seed = int(s['id'][1:]) * 101
    if s['kind'] == 'char':   # edit the approved portrait into the shot, so the face stays the same
        return lambda gpu: kgen(gpu, s['id'], image=PORTRAIT, _auto_resize=False, guidance_scale=2.5,
                                generator=torch.Generator('cpu').manual_seed(seed))
    return lambda gpu: kgen(gpu, s['id'], guidance_scale=3.5, generator=torch.Generator('cpu').manual_seed(seed))
paths = [OUT/'frames'/f"{s['id']}.png" for s in SHOTS['shots']]
run_on_both([(f, frame_job(s)) for f, s in zip(paths, SHOTS['shots'])])
print('minutes:', round((time.time()-t)/60, 1))
sheet(paths, OUT/'frames'/'contact_sheet.png', cols=5)""")
md("""## STOP 3: check the frames
Every character frame must show **the same man** as the approved portrait (scar through the left eyebrow, patch on the right shoulder, head-cloth tail on the left).
To redo one frame: delete its file in `ahzab_out/frames/`, change its seed or prompt in `SHOTS`, and re-run the cell above. Then run on.""")
code("""del KP; gc.collect(); torch.cuda.empty_cache()""")
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
