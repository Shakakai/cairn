import { MemoryRouter } from "@cairn/router-memory";
import { routerConformance } from "../src/index.js";

routerConformance("memory", (host) => new MemoryRouter(host));
