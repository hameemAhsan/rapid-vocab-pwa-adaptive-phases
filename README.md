# Rapid Vocab PWA

A static, offline-first vocabulary PWA with an adaptive phase-based review engine.

## What it does

- Upload CSV words locally
- Stores words in IndexedDB on the device
- Shows one word at a time
- Reveals English meaning, Bangla meaning, and sentence
- Uses Again / Hard / Good / Easy buttons
- Phase 1 randomly divides the CSV into groups of 25
- A group keeps repeating until every word becomes Good or Easy
- The app records how many times each word was shown before completion
- Phase 2 onward rebuilds groups from difficulty records
- Later groups stay at 20 words or more whenever the total list allows it
- Words marked Easy on the first show become confidence words
- Around 3 confidence words are mixed into each later group for light review
- Has a searchable wordlist with phase-performance details
- Exports/imports JSON backups
- Installs as a PWA when served over HTTPS or localhost

## Adaptive phase rules

1. **Phase 1:** all imported words are shuffled and split into 25-word groups.
2. **Within each group:** Again and Hard keep the word inside the current group. Good or Easy completes the word for that phase.
3. **Difficulty recording:** every show is counted. The app stores show count, first rating, final rating, and counts for Again/Hard/Good/Easy.
4. **Confidence pool:** words marked Easy on their first Phase 1 appearance are saved as confidence words.
5. **Phase 2 onward:** difficult/non-easy active words are regrouped by recorded difficulty. Each group is built with active words plus about 3 random confidence words.
6. **Later phases:** the same filtering repeats through Phase 5. Easy-on-first-show words leave the pressure pool, but can still appear as confidence/light-review words.

## CSV format

```csv
word,englishMeaning,banglaMeaning,sentence
relapse,to fall back into a bad condition,পুনরায় খারাপ অবস্থায় ফিরে যাওয়া,After improving for weeks he had a relapse.
```

## Running locally

Because service workers need a server, do not open index.html directly. Use any static server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Deploying

Upload all files to GitHub Pages, Netlify, Vercel, or any static hosting provider. Keep the files in the same structure.

## Important local-storage note

Words are stored on the current browser/device. Use Export Backup regularly if you do not want to lose progress after clearing browser data.

## Restarting phases

Use **Restart Phases** on the Home screen to clear phase progress while keeping the vocabulary list.
