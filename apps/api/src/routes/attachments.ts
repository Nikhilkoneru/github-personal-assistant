import multer from 'multer';
import { Router } from 'express';
import { z } from 'zod';

import { isRagFlowConfigured } from '../config';
import { requireRequestSession } from '../lib/auth';
import { ensureProjectDataset, ingestFile } from '../services/ragflow';
import {
  getAttachmentRecord,
  promoteAttachmentToKnowledge,
  saveAttachment,
  updateAttachmentKnowledgeStatus,
} from '../store/attachment-store';
import { getProjectRecord, setProjectRagFlowDataset } from '../store/project-store';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
  },
});

const promoteSchema = z.object({
  projectId: z.string().trim().min(1),
});

router.post('/api/attachments', (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  upload.single('file')(request, response, async (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        response.status(400).json({ error: 'Attachment exceeds the 20 MB limit.' });
        return;
      }

      response.status(400).json({ error: error.message });
      return;
    }

    if (error) {
      response.status(500).json({ error: error.message });
      return;
    }

    if (!request.file) {
      response.status(400).json({ error: 'No file was uploaded.' });
      return;
    }

    try {
      const attachment = await saveAttachment({
        ownerId: String(session.user.id),
        threadId: typeof request.body.threadId === 'string' ? request.body.threadId : undefined,
        projectId: typeof request.body.projectId === 'string' ? request.body.projectId : undefined,
        originalName: request.file.originalname || 'attachment',
        mimeType: request.file.mimetype || 'application/octet-stream',
        bytes: request.file.buffer,
      });

      response.status(201).json({ attachment });
    } catch (saveError) {
      response.status(500).json({
        error: saveError instanceof Error ? saveError.message : 'Unable to store attachment.',
      });
    }
  });
});

router.post('/api/attachments/:attachmentId/promote', async (request, response) => {
  const session = requireRequestSession(request, response);
  if (!session) {
    return;
  }

  if (!isRagFlowConfigured()) {
    response.status(503).json({ error: 'RagFlow is not configured on the backend yet.' });
    return;
  }

  const parsed = promoteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const ownerId = String(session.user.id);
  const attachment = getAttachmentRecord(ownerId, request.params.attachmentId);
  if (!attachment) {
    response.status(404).json({ error: 'Attachment not found.' });
    return;
  }

  const project = getProjectRecord(ownerId, parsed.data.projectId);
  if (!project) {
    response.status(404).json({ error: 'Project not found.' });
    return;
  }

  try {
    const dataset = await ensureProjectDataset({
      ownerId,
      projectId: project.id,
      projectName: project.name,
      existingDatasetId: project.ragflow_dataset_id,
    });
    if (!project.ragflow_dataset_id) {
      setProjectRagFlowDataset(ownerId, project.id, dataset);
    }

    const uploadResult = await ingestFile({
      datasetId: dataset.datasetId,
      filePath: attachment.file_path,
      fileName: attachment.name,
    });

    const promoted = promoteAttachmentToKnowledge({
      ownerId,
      attachmentId: attachment.id,
      projectId: project.id,
      datasetId: dataset.datasetId,
      documentId: uploadResult.documentId,
    });

    response.json({ attachment: promoted });
  } catch (promoteError) {
    updateAttachmentKnowledgeStatus({
      ownerId,
      attachmentId: attachment.id,
      knowledgeStatus: 'failed',
    });
    response.status(502).json({
      error: promoteError instanceof Error ? promoteError.message : 'Unable to promote attachment to project knowledge.',
    });
  }
});

export default router;
