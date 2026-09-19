import { SetMetadata } from '@nestjs/common';

/**
 * Which face of the system a route belongs to.
 *
 * `internal` is the office: cycles, settlements, supplier costs, margins.
 * `portal` is a shop owner's own data and nothing else.
 * `public` is the catalogue and the two routes needed to sign in.
 * `mcp` is the assistant: a partner talking to the system through Claude. Its
 * tokens are good for the assistant's own routes and nothing else, so what the
 * assistant may change is decided by which routes declare `mcp` — not by how
 * well the model behaves. Every REST route stays `internal` and refuses them.
 *
 * A route that declares nothing is internal. That default is the whole point
 * of the mechanism: `RolesGuard` defaults to *allowing* when no roles are set,
 * so silence there means open, and that is how four modules that move money
 * ended up with no guard at all (CLAUDE.md rule 12). Here silence means closed,
 * and a controller written a year from now is fenced before anyone remembers
 * to fence it.
 */
export type Surface = 'internal' | 'portal' | 'public' | 'mcp';

export const SURFACE_KEY = 'surface';

export const Surface = (surface: Surface) => SetMetadata(SURFACE_KEY, surface);
