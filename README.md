# chordiceps

entrenador auditiu d'acords

## Notes sobre àudio i compatibilitat mòbil

Alguns dispositius mòbils i navegadors requereixen una acció de l'usuari per activar l'AudioContext i poden fallar quan hi ha moltes peticions petites d'àudio. Per millorar la fiabilitat hem implementat:

- Reprendre `AudioContext` en el primer clic al botó Play.
- Decodificació amb WebAudio a mòbils (fetch + decodeAudioData) per reduir l'ús d'HTMLAudioElement.
- Opcional: suport per a audio sprites amb `audios/sprites/map.json` i `audios/sprites/part1.mp3`.

Hi ha un exemple de script per crear sprites a `scripts/build-sprites.sh`.

Veure `index.html` per a més detalls sobre la lògica de pre-càrrega, reintents i fallback sintètic.

### Generar sprites automàticament

Hi ha un script Node a `scripts/generate-sprite.js` que utilitza `ffprobe` i `ffmpeg` per mesurar durades i construir:

- `audios/sprites/part1.mp3` (sprite concatenat)
- `audios/sprites/map.json` (mapeig de clau -> offset i durada)

Requisits: `ffmpeg` i `ffprobe` al PATH. També cal tenir `node` instal·lat.

Exemple d'ús:

```bash
# instal·la minimist si no la tens: npm install minimist
node scripts/generate-sprite.js --out ./audios/sprites/part1.mp3 --map ./audios/sprites/map.json
```
