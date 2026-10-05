const ADJECTIVES = ['amber', 'brisk', 'calm', 'candid', 'clever', 'cosmic', 'crisp', 'dapper', 'eager', 'fuzzy', 'gentle', 'golden', 'hasty', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'mighty', 'nimble', 'noble', 'plucky', 'quiet', 'rapid', 'rusty', 'shiny', 'snappy', 'sunny', 'swift', 'tidy', 'upbeat', 'velvet', 'vivid', 'wily', 'zesty']
const NOUNS = ['badger', 'beacon', 'biscuit', 'comet', 'cricket', 'falcon', 'ferret', 'finch', 'gecko', 'harbor', 'heron', 'iguana', 'kestrel', 'lantern', 'lemur', 'lynx', 'marmot', 'meadow', 'newt', 'orchid', 'otter', 'pebble', 'puffin', 'quokka', 'raven', 'sparrow', 'thistle', 'toucan', 'walrus', 'willow', 'wombat', 'yak', 'zebra', 'anchor', 'compass']

const pick = <T>(list: T[], rng: () => number): T => list[Math.floor(rng() * list.length)]!

/**
 * A memorable, branch-safe name like "amber-otter" that is not already a branch.
 * Collisions grow the name by another adjective; a number is the last resort.
 */
export function worktreeName(existing: ReadonlySet<string>, rng: () => number = Math.random): string {
  for (let extra = 0; extra <= 2; extra++) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const name = [...Array.from({ length: 1 + extra }, () => pick(ADJECTIVES, rng)), pick(NOUNS, rng)].join('-')
      if (!existing.has(name) && !existing.has(`asi/${name}`)) return name
    }
  }
  return `chat-${Math.floor(rng() * 1e6)}`
}
