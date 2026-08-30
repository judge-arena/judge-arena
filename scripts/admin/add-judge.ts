/**
 * ─── Register a judge model from the command line ───────────────────────────
 *
 * Sibling of `create-user.ts`, and it exists for the same reason: the thing it
 * creates is a prerequisite for using the product, and until now the only way
 * to make one was a signed-in browser session.
 *
 * IT REUSES `createCustomJudgeModel` rather than writing the three rows
 * itself. That function is the single choke point every "add a custom judge"
 * caller goes through — `POST /api/models` (mode 'custom') and the config
 * importer are the others — and it owns slug uniqueness and the `model.create`
 * audit row. Re-implementing the inserts here would produce a judge that no
 * audit trail knows about, which is precisely the kind of divergence this
 * codebase keeps a single writer to prevent.
 *
 * WHY IT MATTERS BEYOND CONVENIENCE: a leaderboard means many judges. Adding
 * them one browser form at a time does not scale, and the fields that are easy
 * to get wrong by hand — the exact served model id, the backend, the endpoint's
 * /v1 suffix — are the ones that fail LATE, at judgment time, after a run has
 * already been launched.
 *
 * Usage (inside the cluster, where the database is reachable):
 *   node /app/add-judge.js --name="..." --backend=llamacpp \
 *     --base-model="Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf" \
 *     --endpoint="http://192.168.1.164:8001/v1" \
 *     [--max-tokens=8192] [--temperature=0.3] [--protocol=pairwise] [--dry-run]
 */
import { prisma } from '@/lib/db';
import { createCustomJudgeModel } from '@/lib/model-catalog';

export interface AddJudgeArgs {
  name: string;
  backend: string;
  baseModel: string;
  endpoint?: string;
  maxTokens?: number;
  temperature?: number;
  protocol: string;
  dryRun: boolean;
}

const BACKENDS = ['anthropic', 'openai', 'openrouter', 'vllm', 'llamacpp', 'ollama'] as const;
const PROTOCOLS = ['pointwise', 'pairwise', 'listwise'] as const;

export function parseAddJudgeArgs(argv: string[]): AddJudgeArgs {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit?.slice(k.length + 3);
  };
  const name = get('name');
  const backend = get('backend');
  const baseModel = get('base-model');
  if (!name) throw new Error('--name=<display name> is required');
  if (!backend) throw new Error(`--backend=<${BACKENDS.join('|')}> is required`);
  if (!BACKENDS.includes(backend as (typeof BACKENDS)[number])) {
    throw new Error(`Unknown --backend "${backend}". One of: ${BACKENDS.join(', ')}`);
  }
  if (!baseModel) throw new Error('--base-model=<the id the server actually serves> is required');

  const protocol = get('protocol') ?? 'pairwise';
  if (!PROTOCOLS.includes(protocol as (typeof PROTOCOLS)[number])) {
    throw new Error(`Unknown --protocol "${protocol}". One of: ${PROTOCOLS.join(', ')}`);
  }

  const maxTokens = get('max-tokens') ? Number(get('max-tokens')) : undefined;
  const temperature = get('temperature') ? Number(get('temperature')) : undefined;
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 1)) {
    throw new Error('--max-tokens must be a positive number');
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0)) {
    throw new Error('--temperature must be a non-negative number');
  }

  return {
    name,
    backend,
    baseModel,
    endpoint: get('endpoint'),
    maxTokens,
    temperature,
    protocol,
    dryRun: argv.includes('--dry-run'),
  };
}

export async function runAddJudge(args: AddJudgeArgs): Promise<void> {
  const owner = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (!owner) throw new Error('No admin User exists to own the endpoint.');

  if (args.dryRun) {
    console.log(`[dry-run] would create judge "${args.name}" (${args.backend}, ${args.baseModel}) owned by ${owner.name}`);
    return;
  }

  const created = await createCustomJudgeModel(prisma, owner.id, {
    name: args.name,
    // A self-hosted open-weight model prompted to judge. The catalog's other
    // axis (scoringMechanism) is `critique_generative` for anything that
    // answers in text rather than emitting a scalar from a reward head.
    judgeClass: args.backend === 'anthropic' || args.backend === 'openai' ? 'prompted_api' : 'prompted_open_weight',
    scoringMechanism: 'critique_generative',
    servingBackend: args.backend,
    baseModel: args.baseModel,
    endpoint: args.endpoint ?? '',
    apiKeyEnc: null,
    isActive: true,
  } as never);

  // `createCustomJudgeModel` writes protocolSupport {pointwise:['score']} for
  // every custom judge — a default that is wrong for the pairwise corpora this
  // product actually measures against, and that nothing reads yet, so it would
  // have gone unnoticed until something did.
  const samplingDefaults: Record<string, number> = {};
  if (args.temperature !== undefined) samplingDefaults.temperature = args.temperature;
  if (args.maxTokens !== undefined) samplingDefaults.max_tokens = args.maxTokens;

  await prisma.judgeModelVersion.update({
    where: { id: created.judgeModelVersionId },
    data: {
      protocolSupport: { [args.protocol]: ['selection'] },
      ...(Object.keys(samplingDefaults).length ? { samplingDefaults } : {}),
    },
  });

  console.log(
    JSON.stringify(
      {
        judgeModelId: created.judgeModelId,
        judgeModelVersionId: created.judgeModelVersionId,
        modelEndpointId: created.modelEndpointId,
        owner: owner.name,
        protocolSupport: { [args.protocol]: ['selection'] },
        samplingDefaults,
      },
      null,
      2
    )
  );
  console.log('\nNOT VERIFIED YET. Run the verify route (or POST /api/models/<id>/verify) before');
  console.log('launching a run: `requireOwnedActiveEndpoints` refuses an endpoint with no verifiedAt.');
}
