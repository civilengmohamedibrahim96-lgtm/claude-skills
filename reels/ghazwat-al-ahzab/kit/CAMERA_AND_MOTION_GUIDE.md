# Camera, facial direction and motion library

The **view** is the subject's orientation relative to camera. **Shot size** controls how much of the body is visible. **Camera height** changes the viewpoint; it must not change the person's anatomical identity. **Movement** is the virtual camera's travel. These are separate controls.

## Required view set
- Front/eye-level: look directly into lens (for a quote or emotional reveal)
- Three-quarter left and right: natural dialogue
- True left and right profile: thought and conversation
- Back view: travel, arrival, departures
- High angle: vulnerability, quiet contemplation; avoid overuse
- Low angle: authority, scale, personal conviction; avoid theatrical distortion
- Extreme close-up: eyes and skin details, moment of emotion
- Medium: hands, costume and props
- Full-body: actions and movement
- Over-shoulder: two-person dialogue

## Directing faces
The initial default is NOT smiling. Mood is controlled by the story: `neutral`, `determined`, `concerned`, `grieving`, `angry`, `fearful`, `reflective`, `hopeful`, `joyful`, `surprised`. Keep micro-expressions believable; grief is not mandatory tears, strength is not mandatory shouting.

## Video defaults
- Aspect ratio: 9:16, output target 1080x1920 or higher if supported
- Clip length: 3 to 6 seconds per generated shot, then edit shots together
- Camera movement: slow pan, dolly, arc, drift, or locked frame. Choose ONE movement per shot
- Keep hands away from face in close-up to reduce generation artifacts
- Preserve region/time/season lighting continuity; avoid changing wardrobe across cuts
- For a complete 45-second Reel, start with 8–10 separately generated shots
- No invented verses, hadith or attributed historical quotes. Independently verify sources before publishing

## Important limitation
A text description does not anchor the same face as reliably as an approved reference image. Generate one high-resolution front image per character; then derivative angles and video clips using the same reference where your generator supports it. Angle prompts are specifications, not finished angle images.
