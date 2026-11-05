import type {
  ConverseCommand,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { SpendPeriod, SpendStore } from "../data/spend.mts";

export const PAUSED = "AutoGM is out of juice for the month.";
export class SpendError extends Error {}
export class SpendPaused extends SpendError {}
const UNITS_PER_USD = 1_000_000_000;
export function spendMetric(reason: string) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "WowForever",
            Dimensions: [[]],
            Metrics: [{ Name: "AssistantSpendErrors", Unit: "Count" }],
          },
        ],
      },
      AssistantSpendErrors: 1,
      reason,
    }),
  );
}

export function spendTotalMetric(usd: number) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "WowForever",
            Dimensions: [[]],
            Metrics: [{ Name: "AssistantSpendUsd", Unit: "None" }],
          },
        ],
      },
      AssistantSpendUsd: usd,
    }),
  );
}

export function createSpend(ports: {
  store: SpendStore;
  guildId: string;
  limitUsd?: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  searchUsd: number;
  now(): number;
  notify(content: string): Promise<unknown>;
  report(reason: string): void;
  total(usd: number): void;
}) {
  const valid =
    ports.guildId &&
    [
      ...(ports.limitUsd === undefined ? [] : [ports.limitUsd]),
      ports.inputPerMillionUsd,
      ports.outputPerMillionUsd,
      ports.searchUsd,
    ].every(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        Number.isSafeInteger(Math.ceil(value * UNITS_PER_USD)),
    );
  function month() {
    const date = new Date(ports.now());
    const label = date.toISOString().slice(0, 7);
    return {
      pk: `assistant-spend#${ports.guildId}#${label}`,
      label,
      expiresAt: String(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 8) / 1000,
      ),
    };
  }
  async function notice(period: SpendPeriod, signal: AbortSignal) {
    const claim = String(ports.now());
    try {
      if (await ports.store.notified(period, signal)) return;
      // Reserve before posting so a marker-write outage cannot permit another delivery.
      if (!(await ports.store.claimNotice(period, claim, signal))) return;
      if (await ports.store.notified(period, signal)) return;
      try {
        await ports.notify(
          `AutoGM reached its $${ports.limitUsd} monthly limit (${period.label}, UTC).`,
        );
      } catch {
        ports.report("notice");
        try {
          await ports.store.releaseNotice(
            period,
            claim,
            AbortSignal.timeout(5000),
          );
        } catch {
          ports.report("notice_claim");
        }
        return;
      }
      for (const attempt of [1, 2]) {
        try {
          await ports.store.markNotified(period, AbortSignal.timeout(5000));
          return;
        } catch {
          ports.report("notice_marker");
          if (attempt === 2) return;
        }
      }
    } catch {
      ports.report("notice");
    }
  }
  async function check(signal: AbortSignal) {
    const period = month();
    try {
      if (!valid) throw new Error("Invalid spend configuration");
      if (ports.limitUsd === undefined) return period;
      const units = await ports.store.read(period, signal);
      if (units < Math.ceil(ports.limitUsd * UNITS_PER_USD)) return period;
    } catch {
      ports.report("read");
      throw new SpendError("Spend unavailable");
    }
    await notice(period, signal);
    throw new SpendPaused(PAUSED);
  }
  async function charge(period: SpendPeriod, usd: number) {
    try {
      const units = Math.ceil(usd * UNITS_PER_USD);
      if (!Number.isSafeInteger(units) || units < 0)
        throw new Error("Invalid usage");
      const total = await ports.store.add(
        period,
        units,
        AbortSignal.timeout(5000),
      );
      ports.total(total / UNITS_PER_USD);
      if (
        ports.limitUsd !== undefined &&
        total >= Math.ceil(ports.limitUsd * UNITS_PER_USD)
      )
        await notice(period, AbortSignal.timeout(15000));
    } catch {
      ports.report("write");
      if (ports.limitUsd !== undefined)
        throw new SpendError("Spend unavailable");
    }
  }
  return {
    check,
    bedrock(
      sendModel: (
        command: ConverseCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<ConverseCommandOutput>,
    ) {
      return async (
        command: ConverseCommand,
        options: { abortSignal: AbortSignal },
      ) => {
        const period = await check(options.abortSignal);
        const result = await sendModel(command, options);
        const input = result.usage?.inputTokens;
        const output = result.usage?.outputTokens;
        if (
          typeof input !== "number" ||
          typeof output !== "number" ||
          !Number.isSafeInteger(input) ||
          !Number.isSafeInteger(output) ||
          input < 0 ||
          output < 0
        ) {
          ports.report("usage");
          if (ports.limitUsd !== undefined)
            throw new SpendError("Missing model usage");
          return result;
        }
        await charge(
          period,
          (input * ports.inputPerMillionUsd +
            output * ports.outputPerMillionUsd) /
            1_000_000,
        );
        return result;
      };
    },
    async request(signal: AbortSignal) {
      const period = await check(signal);
      return () => charge(period, ports.searchUsd);
    },
  };
}
