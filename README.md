# Voice Recorder (Vanilla JS)

A simple microphone recorder with live waveform preview, local storage, and playback.

## Features

- Record audio with a single button
- Live waveform preview while recording
- Saved recordings persisted in local storage
- Playback, download, and delete controls
- Responsive layout

## Getting started

1. Open `index.html` in a modern desktop browser.
2. Allow microphone permissions when prompted.
3. Click **Record** to start/stop capturing audio.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In GitHub, go to **Settings → Pages**.
3. Set **Source** to `main` and **/root**, then Save.
4. Visit the URL shown by GitHub Pages once it finishes deploying.

## Notes

- Recordings are stored in the browser's local storage for the current origin.
- Audio is saved as `webm` (browser native format).