# Free pipeline: Kaggle GPU → HyperFrames

Everything the reel needs, made with free open models on a free Kaggle GPU, then assembled and rendered in this repo.

## 1. Kaggle (≈ 2–3 GPU hours of your free 30 a week)
1. Sign in at kaggle.com and verify your phone number (needed for Internet in notebooks).
2. Hugging Face: make a free account, open https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev and click **Agree**, then create a **read** token (Settings → Access Tokens).
3. Kaggle → **Create → New Notebook → File → Import Notebook** → upload `ahzab_free_pipeline.ipynb` from this folder.
4. Right panel: **Accelerator: GPU T4 x2**, **Internet: On**. Add-ons → **Secrets** → add `HF_TOKEN` with your token.
5. Run the cells in order.
   - **Stop 1:** four portraits of CHR-027 appear. Send me the contact sheet if you want a second opinion, then set `CHOSEN = <number>` and continue.
   - **Stop 2:** the first frame of every shot appears. The face must match the portrait (scar through the left eyebrow, patch on the right shoulder, head-cloth tail on the left). Redo any that drift (instructions in the notebook).
   - Stage C makes the 10 moving shots (about 5–10 min each on a T4); Stage D makes the Arabic narration.
6. Download `ahzab_out.zip` from the notebook's **Output** panel.

## 2. Back to the repo
Upload the zip on GitHub to `reels/ghazwat-al-ahzab/reel2/incoming/` on branch `claude/dazzling-archimedes-bgj3r7` (Add file → Upload files), then tell Claude. Claude runs:

```bash
bash free_pipeline/ingest.sh incoming/ahzab_out.zip
npx hyperframes check && npx hyperframes snapshot --review
npx hyperframes render
```

## Files
- `shots.json`: the single source of truth: portrait prompt, the 10 shots (timing, first-frame prompt, motion prompt) and the 4 narration lines. The notebook embeds it; `build_notebook.py` rebuilds the notebook after you edit it.
- `ahzab_free_pipeline.ipynb`: the Kaggle notebook.
- `ingest.sh`: unpacks the results, upscales shots to 1080×1920, fits narration slots.

## Licences and caveats
- **FLUX.1 Kontext [dev] is under the FLUX.1 [dev] non-commercial licence.** Fine for a personal channel; if the account is monetised or commercial, check the licence or swap the image stage.
- LTX-Video and the Edge voice (`ar-SA-HamedNeural`, an unofficial free route) have their own terms.
- The notebook has not been run on a GPU yet; the diffusers calls were checked against diffusers 0.42.1 source. If a cell fails, paste the error to Claude.
- Open models keep a face less reliably than paid ones: Stop 2 exists for that.
