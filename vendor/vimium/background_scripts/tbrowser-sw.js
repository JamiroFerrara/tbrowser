import "./tbrowser-compat.js";
import "./main.js";
import { seed } from "./tbrowser-seed.js";

// No top-level await: service workers disallow it. Vimium listens for
// storage.sync changes, so seeding after boot still applies the settings.
seed();
