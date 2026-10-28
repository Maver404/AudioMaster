# AudioMaster

[English](README.md)

Mastering automatico nel browser per le canzoni generate con **Suno** (e qualunque altro
brano): pulisce gli artefatti tipici dell'audio generato dall'AI, bilancia il suono e porta
il volume esattamente al livello giusto per Spotify, Apple Music, YouTube e le altre
piattaforme. Tutto avviene sul tuo computer: nessun file viene caricato su un server.

## Come si usa

1. Scegli dove andrà il brano (**Streaming** è la scelta consigliata), poi trascina il file
   (MP3, WAV, M4A/AAC, FLAC, OGG) oppure premi **Prova con la demo**.
2. AudioMaster lo analizza e crea subito un master con le impostazioni consigliate.
3. Ascolta il confronto **Originale / Master** (barra spaziatrice per play, tasto **B** per
   passare dall'uno all'altro). Il volume dei due è pareggiato, così giudichi la qualità e
   non il volume.
4. Premi **Scarica il master**: WAV 24-bit (consigliato per i distributori), WAV 16-bit
   (qualità CD, a 44,1 kHz) o MP3 320 kbps. La frequenza di campionamento è automatica.
5. Se vuoi, regola **Carattere**, **Intensità**, quanto **pulire gli artefatti AI** e i
   pulsanti **Suona troppo…**: il master si aggiorna da solo. Con più brani (album, EP)
   **Esporta tutti (ZIP)** li salva insieme, tutti con la stessa destinazione.
6. **Taglia** (sopra la forma d'onda) apre gli strumenti di taglio: trascina per selezionare
   una parte, ascoltala (anche in loop), salvala come estratto del master (**Salva la
   selezione**) oppure togli o tieni solo quella parte del brano prima del mastering
   (**Elimina la selezione** / **Tieni solo la selezione**, sempre annullabili).
7. **Annulla** / **Ripeti** (in alto, oppure Ctrl/⌘ + Z e Ctrl/⌘ + Maiusc + Z) tornano
   indietro o avanti di un passo su ogni modifica al suono: destinazione, carattere,
   regolazioni, tagli (ultimi 50 passi).
8. Il box **Metadati** mostra la copertina e tutti i tag del file (titolo, artista, album,
   testo, link, dati tecnici). Di base il master mantiene copertina e tag; disattiva
   l'opzione per esportare un file pulito.
9. **Tema** (in alto a destra) cambia l'aspetto: Automatico, Scuro, Chiaro, Fluo Techno,
   Analogico, Synthwave o Alto contrasto.

Ogni comando ha un pulsante **(i)** che spiega cosa fa e quando usarlo, con un esempio.
Il pulsante **EN** in alto passa l'interfaccia all'inglese.

## Cosa fa al suono

| Fase | Cosa corregge |
|---|---|
| Pulizia spettrale | fruscio metallico e "shimmer" sulle alte frequenze, fruscio di fondo |
| EQ dinamico | medio-bassi impastati, rimbombo, asprezza 2–6 kHz, sibilanti, "fizz" |
| EQ automatico | equilibrio tonale rispetto all'andamento naturale del brano, o a un brano di riferimento |
| Saturazione e "aria" | calore leggero; ricostruzione delle alte tagliate dagli MP3 |
| Compressione multibanda e "glue" | dinamica più coesa e controllata, senza schiacciare |
| Stereo | bassi in mono (compatibilità e impatto), ampiezza controllata |
| Loudness e limiter true-peak | volume esatto (es. −14 LUFS, −1 dBTP) senza distorsione sui codec |
| Controllo qualità | se un modulo ha peggiorato qualcosa (alte spente, fase), viene ammorbidito |

Le soglie e le ricette sono documentate in [docs/RESEARCH.md](docs/RESEARCH.md); i
contratti tra i moduli in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (in inglese).

## Avvio in locale

Servono solo Node.js 18+ (per il server di sviluppo, la build e i test).

```bash
npm ci             # installa esbuild, l'unica dipendenza (solo per la build)
npm run dev        # → http://localhost:5173
```

Il server di sviluppo risponde solo da questo computer. Per provare l'app sul telefono
nella stessa rete Wi-Fi: `npm run dev -- --host=0.0.0.0` (i file e le cartelle nascosti,
come `.git/`, non vengono mai serviti).

```bash
npm test           # test DSP, loudness (confrontati con ffmpeg se installato), motore, logica UI
```

```bash
npm run build      # → dist/index.html, un unico file che funziona anche aperto da disco
```

`dist/` non va nel repository: si ricrea sempre con `npm run build`.

## Pubblicare su GitHub Pages

Il workflow [.github/workflows/pages.yml](.github/workflows/pages.yml) esegue
`npm ci && npm run build` a ogni push su `main` e pubblica `dist/`. Basta attivarlo una
volta: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Non servono
segreti. Puoi anche avviarlo a mano dalla scheda **Actions** (*Run workflow*).

## Prima di pubblicare un brano

- Controlla le regole del tuo distributore sulla musica generata con l'AI.
- I brani creati con il piano gratuito di Suno non sono licenziati per l'uso commerciale.

## Sotto il cofano

Un'app web senza backend, in moduli ES semplici e senza dipendenze a runtime (l'export MP3
carica lamejs da una CDN solo quando serve). Il motore gira in un Web Worker, con un
fallback nella pagina:

- de-shimmer e riduzione del rumore STFT per gli artefatti AI;
- EQ dinamico a rilevamento relativo (impasto, rimbombo, asprezza, fizz, de-esser) ed EQ
  automatico o su riferimento;
- saturazione leggera ed exciter per l'"aria";
- compressione a 3 bande e di bus, con soglie calibrate sulle parti forti;
- bassi in mono e limiter true-peak con lookahead e sovracampionamento, iterato fino al
  valore LUFS esatto, seguito da un controllo qualità che può ammorbidire i moduli.

La misura della loudness segue ITU-R BS.1770-4 / EBU R128 ed è verificata con l'`ebur128`
di ffmpeg. I metadati vengono letti dai tag ID3v1/v2, MP4, FLAC, Ogg, RIFF e AIFF e
riscritti come ID3v2.3 (MP3) o LIST/INFO più un blocco `id3 ` (WAV).

## Licenza

MIT — vedi [LICENSE](LICENSE). L'encoder MP3 (lamejs, LGPL-3.0) è caricato a runtime e non
è incluso nel repository.
