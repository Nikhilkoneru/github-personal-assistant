import fs from 'node:fs/promises';

import { env, isRagFlowConfigured } from '../config';

type RagFlowEnvelope<T> = {
  code: number;
  message?: string;
  data: T;
};

type RagFlowDataset = {
  id: string;
  name: string;
};

type RagFlowChunk = {
  id: string;
  content?: string;
  text?: string;
  document_id?: string;
  document_name?: string;
  positions?: unknown;
};

const requireConfig = () => {
  if (!isRagFlowConfigured()) {
    throw new Error('RagFlow is not configured on this backend.');
  }

  return {
    baseUrl: env.ragflowBaseUrl!.replace(/\/$/, ''),
    apiKey: env.ragflowApiKey!,
  };
};

const requestJson = async <T>(pathname: string, init?: RequestInit) => {
  const { baseUrl, apiKey } = requireConfig();
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as RagFlowEnvelope<T>;
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message ?? `RagFlow request failed with status ${response.status}.`);
  }

  return payload.data;
};

const requestForm = async <T>(pathname: string, formData: FormData) => {
  const { baseUrl, apiKey } = requireConfig();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  const payload = (await response.json()) as RagFlowEnvelope<T>;
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message ?? `RagFlow request failed with status ${response.status}.`);
  }

  return payload.data;
};

const sanitizeSegment = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'default';

export const ensureProjectDataset = async (input: {
  ownerId: string;
  projectId: string;
  projectName: string;
  existingDatasetId?: string | null;
}) => {
  const datasetName = `${env.ragflowDatasetPrefix}-${sanitizeSegment(input.ownerId)}-${sanitizeSegment(input.projectId)}`;

  if (input.existingDatasetId) {
    return {
      datasetId: input.existingDatasetId,
      datasetName,
    };
  }

  const datasets = await requestJson<RagFlowDataset[]>(
    `/api/v1/datasets?name=${encodeURIComponent(datasetName)}&page=1&page_size=20`,
    { method: 'GET' },
  );
  const existing = datasets.find((dataset) => dataset.name === datasetName);
  if (existing) {
    return { datasetId: existing.id, datasetName: existing.name };
  }

  const created = await requestJson<RagFlowDataset>('/api/v1/datasets', {
    method: 'POST',
    body: JSON.stringify({
      name: datasetName,
      description: `Github Personal Assistant project knowledge for ${input.projectName}`,
      chunk_method: 'naive',
      parser_config: {
        chunk_token_num: 512,
        html4excel: false,
        layout_recognize: 'DeepDOC',
      },
    }),
  });

  return { datasetId: created.id, datasetName: created.name };
};

export const ingestFile = async (input: {
  datasetId: string;
  filePath: string;
  fileName: string;
}) => {
  const bytes = await fs.readFile(input.filePath);
  const formData = new FormData();
  formData.append('file', new Blob([bytes]), input.fileName);
  const result = await requestForm<{ doc_id?: string; id?: string }>(
    `/api/v1/datasets/${encodeURIComponent(input.datasetId)}/documents`,
    formData,
  );

  const { baseUrl, apiKey } = requireConfig();
  await fetch(`${baseUrl}/api/v1/datasets/${encodeURIComponent(input.datasetId)}/chunks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }).catch(() => undefined);

  const documentId = result.doc_id ?? result.id;
  if (!documentId) {
    throw new Error('RagFlow did not return a document id for the uploaded file.');
  }

  return { documentId };
};

export const listDocumentChunks = async (documentId: string) => {
  const data = await requestJson<{ chunks?: RagFlowChunk[] } | RagFlowChunk[]>(
    `/api/v1/documents/${encodeURIComponent(documentId)}/chunks?offset=0&limit=128`,
    { method: 'GET' },
  );

  if (Array.isArray(data)) {
    return data;
  }

  return data.chunks ?? [];
};
