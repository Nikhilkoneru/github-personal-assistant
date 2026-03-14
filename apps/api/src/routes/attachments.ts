import multer from 'multer';
import { Router } from 'express';

import { requireRequestSession } from '../lib/auth.js';
import { saveAttachment } from '../store/attachment-store.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
  },
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

export default router;
