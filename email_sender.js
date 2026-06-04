/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/email','N/file','N/render','N/log','N/record','N/runtime', 'N/search'], (
  email, file, render, log, record, runtime, search
) => {

  // Infer NetSuite file type from MIME or filename; fallback to PLAINTEXT
  function pickFileType(mime = '', name = '') {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const byExt = {
      pdf: file.Type.PDF, csv: file.Type.CSV, txt: file.Type.PLAINTEXT,
      json: file.Type.JSON, xml: file.Type.XMLDOC, html: file.Type.HTMLDOC,
      png: file.Type.PNGIMAGE, jpg: file.Type.JPEG, jpeg: file.Type.JPEG,
      gif: file.Type.GIFIMAGE, bmp: file.Type.BMPIMAGE,
      tiff: file.Type.TIFFIMAGE, doc: file.Type.WORD, docx: file.Type.WORD,
      xls: file.Type.EXCEL, xlsx: file.Type.EXCEL,
      ppt: file.Type.PPT, pptx: file.Type.PPT
    };
    if (byExt[ext]) return byExt[ext];

    const byMime = {
      'application/pdf': file.Type.PDF,
      'text/csv': file.Type.CSV,
      'text/plain': file.Type.PLAINTEXT,
      'application/json': file.Type.JSON,
      'application/xml': file.Type.XMLDOC,
      'text/html': file.Type.HTMLDOC,
      'image/png': file.Type.PNGIMAGE,
      'image/jpeg': file.Type.JPEG,
      'image/gif': file.Type.GIFIMAGE,
      'image/bmp': file.Type.BMPIMAGE,
      'image/tiff': file.Type.TIFFIMAGE,
      'application/msword': file.Type.WORD,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': file.Type.WORD,
      'application/vnd.ms-excel': file.Type.EXCEL,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': file.Type.EXCEL,
      'application/vnd.ms-powerpoint': file.Type.PPT,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': file.Type.PPT
    };
    return byMime[mime] || file.Type.PLAINTEXT;
  }

  function saveBase64Attachment(att, folderId) {
    const f = file.create({
      name: att.name || ('upload-' + Date.now()),
      fileType: pickFileType(att.type, att.name),
      contents: att.base64 || '',
      encoding: file.Encoding.BASE_64,
      folder: folderId ? Number(folderId) : undefined
    });
    const fileId = f.save();
    return file.load({ id: fileId }); // return a File object usable by email.send
  }

  function renderTxnPdfAsFile(txnId) {
  const pdfFile = render.transaction({
    entityId: Number(txnId),
    printMode: render.PrintMode.PDF
  });

  // Default fallback name if lookup fails
  let fileName = `Transaction_${txnId}`;
  try {
    const fields = search.lookupFields({
      type: 'transaction',
      id: txnId,
      columns: ['tranid']
    });
    if (fields && fields.tranid) {
      // Sanitize: remove characters that are problematic in filenames
      fileName = String(fields.tranid).trim().replace(/[\\/:*?"<>|]/g, '_');
    }
  } catch (e) {
    log.error('Lookup tranid error', { txnId, error: e.message });
  }

  pdfFile.name = `${fileName}.pdf`;
  return pdfFile;
}

  function splitRecipients(recipientObjs) {
    const to = [], cc = [], bcc = [];
    (recipientObjs || []).forEach(r => {
      const addr = (r && r.email || '').trim();
      if (!addr) return;
      if (r.to)  to.push(addr);
      if (r.cc)  cc.push(addr);
      if (r.bcc) bcc.push(addr);
    });
    // Avoid empty TO (NetSuite requires at least one)
    return { to, cc, bcc };
  }

  function unique(arr) {
    const seen = {};
    return (arr || []).filter(v => {
      const k = String(v).toLowerCase();
      if (seen[k]) return false;
      seen[k] = true; return true;
    });
  }


  function GET(request) {
  try {
    if (request.action === 'merge') {
      const templateId = Number(request.templateId);
      if (!templateId) throw new Error('templateId is required.');

      const isInvGrp = String(request.recordType || '') === 'invoicegroup';
      const recordId = Number(request.recordId) || null;
      const custId   = Number(request.custId)   || null;

      
      
      log.debug('custId', custId)
      log.debug('templateId', templateId)

      let merged;
      try {
        merged = render.mergeEmail({
          templateId: parseInt(templateId),
          transactionId: parseInt(recordId),
          entityId: parseInt(custId)
        });
        log.debug('merged', merged)
      } catch (mergeErr) {
        // Fallback: entity-only merge (matches your old beforeLoad logic)
        log.debug('Merge fallback for template ' + templateId, mergeErr.message);
        merged = render.mergeEmail({
          templateId: templateId,
          entityId: custId
        });
      }
      log.debug('subject', merged.subject)
      log.debug('body', merged.body)

var result = {
  success: true,
  subject: String(merged.subject || ''),
  body: String(merged.body || '')
};
return result;
    }

    return { success: false, message: 'Unknown action.' };
  } catch (e) {
    log.error('RESTlet Merge Error', { message: e.message, stack: e.stack });
    return { success: false, message: e.message || String(e) };
  }
}

  function POST(request) {
    try {
      const author            = Number(request.author) || runtime.getCurrentUser().id;
      const subject           = String(request.subject || '').trim();
      const htmlBody          = String(request.body || '');
      const recordId          = Number(request.recordId || 0);
      const includeTransaction= !!request.includeTransaction;
      const folderIdForUploads= Number(request.folderId || 80334); // optional target folder for uploaded files
      const attachmentsIn     = Array.isArray(request.attachments) ? request.attachments : [];
      const recips            = Array.isArray(request.recipients) ? request.recipients : [];

      if (!subject) throw new Error('Subject is required.');
      const { to, cc, bcc } = splitRecipients(recips);
      if (!to.length && !cc.length && !bcc.length) {
        throw new Error('At least one recipient (TO/CC/BCC) is required.');
      }

      // Build attachments array of File objects
      const atts = [];

      // 1) Optional: attach transaction PDF
      if (includeTransaction && recordId) {
        try {
          atts.push(renderTxnPdfAsFile(recordId));
        } catch (e) {
          log.error('RenderTxnPDF error', e);
          // do not block the email on PDF render failure
        }
      }

      // 2) Uploaded base64 files
      for (let i = 0; i < attachmentsIn.length; i++) {
        const a = attachmentsIn[i] || {};
        if (!a.base64) continue;
        try {
          atts.push(saveBase64Attachment(a, folderIdForUploads));
        } catch (e) {
          log.error('SaveAttachment error for ' + (a.name || 'unnamed'), e);
          // continue with remaining files
        }
      }

      // Send the email
      email.send({
        author,
        recipients: unique(to.length ? to : cc.length ? cc : bcc), // NetSuite requires non-empty recipients; use TO if present else fallback
        subject,
        body: htmlBody,        // HTML is fine; NetSuite will send as HTML if body contains tags
        cc: unique(cc),
        bcc: unique(bcc),
        attachments: atts,
        relatedRecords: recordId ? { transactionId: recordId } : undefined
      });

      return { success: true };
    } catch (e) {
      log.error('RESTlet Send Email Error', { message: e.message, stack: e.stack });
      return { success: false, message: e.message || String(e) };
    }
  }

  return { get: GET, post: POST };
});
