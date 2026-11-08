# Promo Lab
Use Node.js 22. Open a terminal in this folder and run `npm run dev`. Visit http://127.0.0.1:4317. No external runtime packages need installation.

1. Select **Try a sample**, **Offline baseline**, then **Find promos**.
2. Open a candidate to see its segment start/end times and source records. Use the Coverage and Agent activity panels to inspect results or failures.
3. To try a new episode, select one timed TXT or JSON file. The folder importer accepts the supplied Kuku episode format. A JSON example is in public/sample.json. Timestamps may be seconds or MM:SS.mmm. A record needs episode, start, end and text. The engine uses exact source IDs and bounds.
4. For connected model mode, copy .env.example to .env and supply your own provider credentials. Restart the local server and select **Connected model**. This sends submitted excerpts to your configured provider. A local run does not require APP_ACCESS_TOKEN. For model-enabled hosting, set an access token.
5. Choose **Explore multi-segment promos** to test assembly. Export a run to retain source evidence, decisions and separate editorial feedback.

## Verification
`npm test` runs the regression suite. `npm run build` writes static frontend assets to dist/. The Node backend is in api/.

## Reproduce the full-pack baseline
With access to the original Kuku episode folder, run `node scripts/import-pack.js "PATH_TO_EPISODE_FILES"`, then `npm run evaluate`. This writes a new report in private-outputs/. Run IDs, timestamps and elapsed time change on each run.

## Files and privacy
The bundled public/sample.json is synthetic. Private inputs, credentials, personal runtime files and full model request logs are excluded from the prototype. ARCHITECTURE.md explains worker roles and design decisions. The raw-outputs folder in the evaluator bundle is for private review and includes selected screenplay excerpts.
