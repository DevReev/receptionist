// Parallel-run routing for IMP-10 (spec §10, map ticket 01).
//
// The per-Location toggle lives in the clinic guide (`clinic.md`,
// `## Locations`): each Location points at Picktime or the clone and the
// Receptionist routes by the Location of the call. Flipping is a human edit
// to that file — no admin UI.
//
// Toggle syntax (canonical definition in `booking/lib/parallel-run.ts`;
// duplicated here so the receptionist never imports across contexts):
// `- **Name** … books on: clone` flips one Location; absent or unparsable
// fails closed to `picktime`.

export type RoutingTarget = 'picktime' | 'clone';

export const DEFAULT_ROUTING_TARGET: RoutingTarget = 'picktime';

const BOLD_NAME_RE = /-\s+\*\*(.+?)\*\*/;
const TOGGLE_RE = /books\s+on\s*:\s*(picktime|clone)/i;

function sectionLines(raw: string, title: string): string[] {
  const lines = raw.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = heading[1]!.trim().toLowerCase() === title.toLowerCase();
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

function shortName(name: string): string {
  return name.split(',')[0]!.trim();
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

/** Location name → routing target for the guide's `## Locations` section. */
export function parseLocationRouting(raw: string): Map<string, RoutingTarget> {
  const out = new Map<string, RoutingTarget>();
  for (const line of sectionLines(raw, 'Locations')) {
    const nameMatch = BOLD_NAME_RE.exec(line);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    if (!name) continue;
    const toggle = TOGGLE_RE.exec(line);
    out.set(name, toggle ? (toggle[1]!.toLowerCase() as RoutingTarget) : DEFAULT_ROUTING_TARGET);
  }
  return out;
}

/**
 * Which system books this Location. Case-insensitive, short-name aware
 * (`Bobby Clinic` matches a `Bobby Clinic, …` Picktime label); unknown
 * names fail closed to `picktime`.
 */
export function routeForLocation(raw: string, locationName: string): RoutingTarget {
  const table = parseLocationRouting(raw);
  const want = norm(locationName);
  const wantShort = norm(shortName(locationName));
  for (const [name, target] of table) {
    if (norm(name) === want) return target;
  }
  for (const [name, target] of table) {
    if (norm(shortName(name)) === wantShort) return target;
  }
  return DEFAULT_ROUTING_TARGET;
}

/** Alias used at the booking edge: the guide text decides the write path. */
export function resolveBookingTarget(guideRaw: string, locationName: string): RoutingTarget {
  return routeForLocation(guideRaw, locationName);
}
