import {
  AutoModel,
  AutoTokenizer,
  LogLevel,
  env,
} from "@huggingface/transformers";

const DEFAULT_MODEL_ID = "onnx-community/harrier-oss-v1-0.6b-ONNX";
const DEFAULT_DOCUMENT_BATCH_SIZE = 8;
const DEFAULT_MAX_LENGTH = 32_768;

export interface HarrierEmbedderOptions {
  modelId?: string;
  cacheDir?: string;
  localModelPath?: string;
  localFilesOnly?: boolean;
  device?: string;
  dtype?: string;
  maxLength?: number;
  batchSize?: number;
}

export interface HarrierQueryOptions {
  task?: string;
}

type TokenizerLike = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type ModelLike = Awaited<ReturnType<typeof AutoModel.from_pretrained>>;

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function tensorToRows(tensor: { data: ArrayLike<number>; dims: number[] }): number[][] {
  const [batchSize, width] = tensor.dims;
  const rows: number[][] = [];
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex++) {
    const offset = batchIndex * width;
    const row: number[] = [];
    for (let hiddenIndex = 0; hiddenIndex < width; hiddenIndex++) {
      row.push(Number(tensor.data[offset + hiddenIndex] ?? 0));
    }
    rows.push(row);
  }
  return rows;
}

function l2Normalize(rows: number[][]): number[][] {
  return rows.map((row) => {
    let sumSquares = 0;
    for (const value of row) sumSquares += value * value;
    const norm = Math.sqrt(sumSquares) || 1;
    return row.map((value) => value / norm);
  });
}

function lastTokenPool(outputs: { data: ArrayLike<number>; dims: number[] }, attentionMask: { data: ArrayLike<number | bigint>; dims: number[] }): number[][] {
  const [batchSize, sequenceLength, hiddenSize] = outputs.dims;
  const rows: number[][] = [];
  const maskData = attentionMask.data;
  const hiddenData = outputs.data;

  for (let batchIndex = 0; batchIndex < batchSize; batchIndex++) {
    let lastTokenIndex = sequenceLength - 1;
    for (let tokenIndex = sequenceLength - 1; tokenIndex >= 0; tokenIndex--) {
      const maskOffset = (batchIndex * sequenceLength) + tokenIndex;
      if (toNumber(maskData[maskOffset]) > 0) {
        lastTokenIndex = tokenIndex;
        break;
      }
    }

    const row: number[] = [];
    const hiddenOffset = ((batchIndex * sequenceLength) + lastTokenIndex) * hiddenSize;
    for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex++) {
      row.push(Number(hiddenData[hiddenOffset + hiddenIndex] ?? 0));
    }
    rows.push(row);
  }

  return rows;
}

function formatQuery(task: string, query: string): string {
  return `Instruct: ${task}\nQuery: ${query}`;
}

export class HarrierEmbedder {
  readonly modelId: string;
  private tokenizerPromise: Promise<TokenizerLike> | null = null;
  private modelPromise: Promise<ModelLike> | null = null;
  private readonly options: Required<Pick<HarrierEmbedderOptions, "maxLength" | "batchSize">> & HarrierEmbedderOptions;

  constructor(options: HarrierEmbedderOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.options = {
      ...options,
      maxLength: options.maxLength ?? DEFAULT_MAX_LENGTH,
      batchSize: options.batchSize ?? DEFAULT_DOCUMENT_BATCH_SIZE,
    };
    if (options.cacheDir) env.cacheDir = options.cacheDir;
    if (options.localModelPath) env.localModelPath = options.localModelPath;
    env.logLevel = LogLevel.ERROR;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedInternal(texts);
  }

  async embedQueries(texts: string[], options: HarrierQueryOptions = {}): Promise<number[][]> {
    const task = options.task ?? "Given a user query, retrieve relevant memory rows and session events";
    return this.embedInternal(texts.map((text) => formatQuery(task, text)));
  }

  private async load(): Promise<{ tokenizer: TokenizerLike; model: ModelLike }> {
    if (!this.tokenizerPromise) {
      this.tokenizerPromise = AutoTokenizer.from_pretrained(this.modelId, {
        local_files_only: this.options.localFilesOnly,
      });
    }
    if (!this.modelPromise) {
      this.modelPromise = AutoModel.from_pretrained(this.modelId, {
        local_files_only: this.options.localFilesOnly,
        device: (this.options.device ?? "cpu") as any,
        dtype: this.options.dtype as any,
      });
    }
    const [tokenizer, model] = await Promise.all([this.tokenizerPromise, this.modelPromise]);
    return { tokenizer, model };
  }

  private async embedInternal(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const rows: number[][] = [];

    for (let start = 0; start < texts.length; start += this.options.batchSize) {
      const batch = texts.slice(start, start + this.options.batchSize);
      const inputs = tokenizer(batch, {
        padding: true,
        truncation: true,
        max_length: this.options.maxLength,
      }) as Record<string, unknown>;
      const outputs = await model(inputs);
      const sentenceEmbedding = (outputs as Record<string, unknown>)["sentence_embedding"];
      if (sentenceEmbedding && typeof sentenceEmbedding === "object" && sentenceEmbedding !== null) {
        rows.push(...l2Normalize(tensorToRows(sentenceEmbedding as { data: ArrayLike<number>; dims: number[] })));
        continue;
      }

      const lastHiddenState = (outputs as Record<string, unknown>)["last_hidden_state"];
      const attentionMask = inputs["attention_mask"];
      if (!lastHiddenState || typeof lastHiddenState !== "object" || !attentionMask || typeof attentionMask !== "object") {
        throw new Error(`Harrier model "${this.modelId}" did not return a usable embedding tensor`);
      }
      rows.push(...l2Normalize(
        lastTokenPool(
          lastHiddenState as { data: ArrayLike<number>; dims: number[] },
          attentionMask as { data: ArrayLike<number | bigint>; dims: number[] },
        ),
      ));
    }

    return rows;
  }
}
