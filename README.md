# SubDrop

English | [فارسی](README.fa.md)

## Where the idea came from, and what it is good for

I decided to start watching the math courses for machine learning on deeplearning.ai — but there was a problem: the videos are in English and my native language is Persian.

I had a few options:

1. **Free Firefox extensions** — but their translation was word-by-word and literal; they would translate "bias" as "تعصب" (prejudice)!

2. **Firefox's built-in page translation** — which had the same problem as option 1.

3. **Extensions that translate the text through an AI API** — but those cost money.

4. **The last resort:** copy the transcript that deeplearning.ai itself shows me, translate it with an AI, and then try to follow the translated text alongside the video and keep it in sync!!!

That is where this idea came from: what if I could take that AI-translated text and put it right where the site's subtitles go, with an extension? It is free, the translation is accurate and technical, and it is easy — especially when the site hands you a transcript, and luckily deeplearning.ai provides its English captions in exactly this nice form:

![deeplearning.ai transcript](docs/dlai-transcript.png)

SubDrop fills exactly that missing piece: it takes your translated text (or any `.srt`/`.vtt` file) and puts it on the video, keeping it locked to the video's time.



## What is SubDrop?

A Firefox extension that displays a `.srt` or `.vtt` subtitle file over any page's video and stays synced to `video.currentTime`. Persian and right-to-left text are fully supported.

It can also **extract the site's own captions** so you can copy them, translate them with the AI of your choice, and load them back as Persian subtitles. It does not translate anything itself — it stays free and leaves the translation to your tool.

## Features

- **Subtitle overlay** on any `<video>` — synced to `video.currentTime`, still correct after seeking
- **Persian & RTL** — per-line direction detection, proper Persian fonts
- **Glass status chip** in the page corner: colored dot + file name and cue count
- **Per-site memory** — each site's subtitle is remembered; it comes back automatically after a reload or a return visit
- **Sync offset** — nudge subtitles in ±0.1 s steps, remembered per site
- **Appearance** — text color (black/white), font size (auto or fixed), and font (Vazirmatn, Noto Naskh/Sans/Kufi Arabic, Nastaliq, Tahoma…)
- **Caption extraction**, four ways:
  1. a site's `<track src>` — direct `.vtt`/`.srt` files or HLS playlists
  2. TextTracks the player has already built and filled
  3. TextTracks that only fill once enabled (players like YouTube/Vimeo)
  4. **Manual URL** — if none of those exist, give it a subtitle file URL to fetch
- **Copy as SRT or plain text** — the SRT output is loadable again as-is
- **Paste from clipboard** — subtitle text copied anywhere (the AI's answer, for example) loads straight onto the video, no file needed
- **Fullscreen** — the overlay moves inside the fullscreen element so it stays visible

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `dist/subdrop-0.4.xpi` (the `manifest.json` works too)
3. Refresh the video tab

After changing any code you must Remove and Load the add-on again. To rebuild the installable file, run `./build.sh`.

## Usage

**Loading a subtitle file:** click **Choose subtitle file** in the popup — a small window opens; pick a file or drop one there. The window closes itself and the subtitle lands on the video. (You can also drop a file straight onto the status chip in the page corner.)

**Pasting subtitle text:** if the subtitle text is already on your clipboard — the AI's answer, for example — hit **Paste from clipboard** in the popup and it loads without saving a file. The text is checked first: anything without valid SRT/VTT timestamps is rejected with a message, and whatever is on the video stays untouched.

Why a window? Firefox tears the browser-action popup down the moment a native file dialog opens; a separate window avoids that entirely.

**The AI workflow:**

1. Popup → **Extract captions** → pick a language
2. Hit **Copy SRT**
3. Give the text to your AI and ask it to translate only the caption lines, leaving the timestamps untouched
4. Copy the result and hit **Paste from clipboard** — done, no file to save. (You can still save it as `.srt` and load it with **Choose subtitle file**.)

## Limitations

- Firefox's Picture-in-Picture window is not supported (nothing can be injected into it)
- DRM players (Netflix and the like) do not work
- Extraction depends on the site's structure; the four paths above cover the common cases but no site can be guaranteed

## Privacy

Nothing is sent anywhere and nothing is tracked. The only network request is fetching a subtitle file you asked for (caption extraction). Subtitles and settings are stored locally only. The clipboard is read only at the moment you press **Paste from clipboard**, and what it holds never leaves your machine.

## Layout

```
manifest.json   add-on definition (MV2)
parser.js       SRT/VTT parser + encoding detection + SRT writer
content.js      overlay, syncing, status chip, per-site memory
popup.html/js   popup
picker.html/js  file picker window
background.js   cross-origin subtitle fetching
build.sh        builds the installable .xpi
docs/           images
```

## License

[MIT](LICENSE)
