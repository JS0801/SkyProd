/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
  'N/ui/serverWidget',
  'N/search',
  'N/runtime',
  'N/query',
  'N/render',
  'N/email',
  'N/file',
  'N/record'
], function (ui, search, runtime, query, render, email, file, record) {

  function onRequest(context) {
    try {
      if (context.request.method === 'GET') {
    if (context.request.parameters.action === 'merge') {
        handleMerge(context);
        return;
    }
    handleGet(context);
    return;
}

      if (context.request.method === 'POST') {
        handlePost(context);
        return;
      }

      context.response.write('Unsupported request method.');
    } catch (e) {
      log.error('Suitelet error', e);
      context.response.write('<html><body><h3>Error</h3><pre>' + escapeHtml(String(e && e.message || e)) + '</pre></body></html>');
    }
  }

  function handleMerge(context) {
    var req = context.request;
    var templateId = req.parameters.templateid || '';
    var custId     = req.parameters.custid || '';
    var recId      = req.parameters.recid || '';
    var recType    = req.parameters.rectype || '';
    var result = { subject: '', body: '' };

    try {
        var isTxn = recType && recType !== 'invoicegroup';
        var merged;
        try {
            merged = render.mergeEmail({
                templateId: Number(templateId),
                transactionId: isTxn ? (Number(recId) || null) : null,
                entityId: custId ? Number(custId) : null
            });
        } catch (e) {
            merged = render.mergeEmail({ templateId: Number(templateId) }); // your old fallback
        }
        result.subject = merged && merged.subject ? String(merged.subject) : '';
        result.body    = merged && merged.body    ? String(merged.body)    : '';
    } catch (e) {
        log.error('handleMerge error', e);
    }

    context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
    context.response.write(JSON.stringify(result));
}

  function handleGet(context) {
    var req = context.request;
    var recId = req.parameters.recid || '';
    var customerId = req.parameters.custid || '';
    var recType = req.parameters.rectype || '';
    var classId = req.parameters.classid || '';
    var authorId = req.parameters.authorid || '';
    var authorName = req.parameters.authorname || '';
    var authorEmail = req.parameters.authoremail || '';
    log.debug('classId', classId)
    log.debug('authorId', authorId)
    log.debug('customerId', customerId)

    if (!recId) {
      context.response.write('Missing Invoice Group ID.');
      return;
    }

    var form = ui.createForm({
      title: ' '
    });
    form.clientScriptModulePath = './BPC_Sky_SL_CS_Helper.js';

    var authorObj = {
      id: authorId,
      name: authorName,
      email: authorEmail
    };

var data = getPopupData(recId, authorObj, customerId, classId, recType);

    addHiddenLongText(form, 'custpage_email_customers', 'Email Customers Data', JSON.stringify(data.customerList || []));
    addHiddenLongText(form, 'custpage_email_templates', 'Email Templates Data', JSON.stringify(data.emailTemplateList || []));
    addHiddenLongText(form, 'custpage_email_employees', 'Email Employees Data', JSON.stringify(data.employeeList || []));
   // addHiddenLongText(form, 'custpage_email_premerged', 'Email Premerged Data', JSON.stringify(data.preMergedById || {}));
    addHiddenLongText(form, 'custpage_email_payload', 'Email Payload', '');
    addHiddenText(form, 'custpage_email_custid', 'Customer ID', String(customerId || ''));
    addHiddenText(form, 'custpage_email_recordid', 'Email Record ID', String(recId || ''));
    addHiddenText(form, 'custpage_email_recordtype', 'Email Record Type',  String(recType || ''));

    var htmlFld = form.addField({
      id: 'custpage_email_html',
      type: ui.FieldType.INLINEHTML,
      label: 'Email HTML'
    });
    htmlFld.defaultValue = buildHtml();

    context.response.writePage(form);
  }

  function handlePost(context) {
    var req = context.request;
    var payloadText = req.parameters.custpage_email_payload || '';
    log.debug('Post Param', req.parameters)

    if (!payloadText) {
      writeScriptResponse(context, false, 'Missing payload.');
      return;
    }

    var payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (e) {
      writeScriptResponse(context, false, 'Invalid payload JSON.');
      return;
    }

    var recordType = payload.recordType || req.parameters.rectype || '';
var recId      = payload.recordId   || req.parameters.recid   || '';

    var custID = req.parameters.custid || '';
    var toList = [];
    var ccList = [];
    var bccList = [];
    var i;

    for (i = 0; i < (payload.recipients || []).length; i++) {
      var r = payload.recipients[i];
      if (!r || !r.email) continue;

      if (r.to) toList.push(r.email);
      if (r.cc) ccList.push(r.email);
      if (r.bcc) bccList.push(r.email);
    }

    if (!toList.length && !ccList.length && !bccList.length) {
      writeScriptResponse(context, false, 'No recipients found.');
      return;
    }

    var attachments = [];
    for (i = 0; i < (payload.attachments || []).length; i++) {
      var a = payload.attachments[i];
      if (!a || !a.name || !a.base64) continue;

      try {
        attachments.push(file.create({
          name: a.name,
          fileType: getFileType(a.name),
          contents: a.base64,
          encoding: file.Encoding.BASE_64
        }));
      } catch (fileErr) {
        log.error('Attachment create error for ' + a.name, fileErr);
      }
    }

    if (payload.includeTransaction && recId) {
    try {
        if (recordType === 'invoicegroup') {
            var invoiceGroupRecord = record.load({ type: 'invoicegroup', id: Number(recId) });
            var pdfName  = invoiceGroupRecord.getValue('invoicegroupnumber');
            var renderer = render.create();
            renderer.setTemplateByScriptId('CUSTTMPL_SKY_INVOICE_GROUP_TEMPLATE');
            renderer.addRecord('record', invoiceGroupRecord);
            var pdfFile = renderer.renderAsPdf();
            pdfFile.name = pdfName + '.pdf';
            attachments.push(pdfFile);
        } else {
            var txnPdf = render.transaction({
                entityId: Number(recId),
                printMode: render.PrintMode.PDF
            });
            var fileName = 'Transaction_' + recId;
            try {
                var f = search.lookupFields({ type: 'transaction', id: recId, columns: ['tranid'] });
                if (f && f.tranid) fileName = String(f.tranid).trim().replace(/[\\/:*?"<>|]/g, '_');
            } catch (e) { log.error('Lookup tranid error', { recId: recId, error: e.message }); }
            txnPdf.name = fileName + '.pdf';
            attachments.push(txnPdf);
        }
    } catch (pdfErr) {
        log.error('PDF generation error', pdfErr);
    }
}
    
    try {
      email.send({
        author: Number(payload.author),
        recipients: toList,
        cc: ccList,
        bcc: bccList,
        subject: payload.subject || '',
        body: payload.body || '',
        attachments: attachments,
        relatedRecords: (recordType === 'invoicegroup') ? { entityId: custID } : { transactionId: Number(recId) }
      });

      log.debug('custID', custID)

      writeScriptResponse(context, true, 'Email sent successfully.');
    } catch (sendErr) {
      log.error('email.send error', sendErr);
      writeScriptResponse(context, false, String(sendErr && sendErr.message || sendErr));
    }
  }

  function writeScriptResponse(context, success, message) {
    var safeMessage = escapeHtml(message || '');
    var html = ''
      + '<html><body><script>'
      + 'var ok=' + (success ? 'true' : 'false') + ';'
      + 'var msg="' + safeMessage.replace(/"/g, '\\"') + '";'
      + 'if(ok){'
      + '  alert(msg);'
      + '  if(window.parent && typeof window.parent.closeInvoiceGroupEmailPopup==="function"){'
      + '    window.parent.closeInvoiceGroupEmailPopup();'
      + '    try{window.parent.location.reload();}catch(e){}'
      + '  }'
      + '}else{'
      + '  alert("Failed to send email: " + msg);'
      + '  if(window.parent && window.parent.document){'
      + '    try{'
      + '      var loader = window.parent.document.getElementById("nsEmailLoaderOverlay");'
      + '      if(loader) loader.style.display="none";'
      + '    }catch(e2){}'
      + '  }'
      + '}'
      + '</script></body></html>';

    context.response.write(html);
  }

  function getPopupData(recId, passedAuthor, customerId, classId, recType) {
    var out = { customerList: [], emailTemplateList: [], employeeList: [], preMergedById: {} };
    out.customerList     = getCustomerRecipients(customerId, recId, recType);
    out.employeeList     = getEmployeeList(passedAuthor, classId);   // unchanged
    out.emailTemplateList= getEmailTemplates();                       // unchanged
   // out.preMergedById    = getPreMergedTemplates(out.emailTemplateList, customerId, recId, recType);
    return out;
}

  function getCustomerRecipients(custID, recId, recType) {
    var list = [];
    var added = {};

    try {
      if (custID) {
        var sql =
          "SELECT " +
          "BUILTIN_RESULT.TYPE_INTEGER(entity.ID) AS id, " +
          "BUILTIN_RESULT.TYPE_STRING(entity.altname) AS altname, " +
          "BUILTIN_RESULT.TYPE_STRING(entity.email) AS email " +
          "FROM entity " +
          "WHERE entity.email IS NOT NULL " +
          "AND entity.ID = " + Number(custID);

        var rs = query.runSuiteQL({ query: sql });
        var rows = rs.asMappedResults() || [];

        if (rows.length > 0) {
          pushRecipient(list, added, {
            id: rows[0].id,
            name: String(rows[0].altname || '') + ' (' + String(rows[0].email || '') + ')',
            email: rows[0].email
          });
        }
      }
    } catch (e1) {
      log.error('entity email fetch error', e1);
    }

    try {
      if (custID) {


        var contactFilters;
        if (recType === 'invoicegroup') {
            contactFilters = [['company', 'anyof', custID], 'AND', ['email', 'isnotempty', '']];
        } else if (recId) {
            contactFilters = [['transaction.internalid', 'anyof', recId], 'AND', ['email', 'isnotempty', '']];
        }

        
        search.create({
          type: 'contact',
          filters: contactFilters,
          columns: [
            search.createColumn({ name: 'internalid' }),
            search.createColumn({ name: 'entityid' }),
            search.createColumn({ name: 'email' })
          ]
        }).run().each(function (result) {
          pushRecipient(list, added, {
            id: result.getValue({ name: 'internalid' }),
            name: String(result.getValue({ name: 'entityid' }) || '') + ' (' + String(result.getValue({ name: 'email' }) || '') + ')',
            email: result.getValue({ name: 'email' })
          });
          return true;
        });
      }
    } catch (e2) {
      log.error('contact fetch error', e2);
    }

    return list;
  }

  function pushRecipient(list, added, obj) {
    var emailAddr = String(obj.email || '').replace(/^\s+|\s+$/g, '');
    if (!emailAddr) return;

    var key = emailAddr.toLowerCase();
    if (added[key]) return;
    added[key] = true;

    list.push({
      id: String(obj.id || ''),
      name: String(obj.name || ''),
      email: emailAddr
    });
  }

  function getEmployeeList(passedAuthor, classId) {
    var employeeList = [];
    var defaultID = '';
    var addedMap = {};

    function pushEmployee(id, name, email, isDefault) {
        id = String(id || '');
        name = String(name || '');
        email = String(email || '');

        if (!id && !email) return;

        var key = (id || email).toLowerCase();
        if (addedMap[key]) return;
        addedMap[key] = true;

        var obj = {
            id: id,
            name: name,
            email: email
        };

        if (isDefault) {
            obj.default = true;
            defaultID = id;
        }

        employeeList.push(obj);
    }

    log.debug('classId', classId)

    try {
        if (classId) {
            var classificationSearchObj = search.create({
                type: "classification",
                filters: [
                    ["isinactive", "is", "F"]
                ],
                columns: [
                    search.createColumn({
                        name: "internalid",
                        label: "Internal ID"
                    }),
                    search.createColumn({
                        name: "internalid",
                        join: "CUSTRECORD_BPC_EMAIL_AUTHOR",
                        label: "Author Internal ID"
                    }),
                    search.createColumn({
                        name: "entityid",
                        join: "CUSTRECORD_BPC_EMAIL_AUTHOR",
                        label: "Name"
                    }),
                    search.createColumn({
                        name: "email",
                        join: "CUSTRECORD_BPC_EMAIL_AUTHOR",
                        label: "Email"
                    })
                ]
            });

            classificationSearchObj.run().each(function (result) {
                var authorId = result.getValue({
                    name: "internalid",
                    join: "CUSTRECORD_BPC_EMAIL_AUTHOR"
                });

                var authorName = result.getValue({
                    name: "entityid",
                    join: "CUSTRECORD_BPC_EMAIL_AUTHOR"
                });

                var authorEmail = result.getValue({
                    name: "email",
                    join: "CUSTRECORD_BPC_EMAIL_AUTHOR"
                });

                var serInternalId = result.getValue({
                    name: "internalid"
                });

                var defaultV = false;
                if (serInternalId == classId) defaultV = true;

                pushEmployee(authorId, authorName, authorEmail, defaultV);
                return true;
            });
        }
      log.debug('employeeList', employeeList)
    } catch (e) {
        log.error('getEmployeeList classification search error', e);
    }

        if (passedAuthor && passedAuthor.id) {
        pushEmployee(
            passedAuthor.id,
            passedAuthor.name,
            passedAuthor.email,
            !defaultID
        );
    }


    // --- Pull in all employees flagged as email authors (custentity_bpc_email_author) ---
    try {
        var emailAuthorSearch = search.create({
            type: "employee",
            filters: [
                ["custentity_bpc_email_author", "is", "T"],
                "AND",
                ["isinactive", "is", "F"],
            "AND",
            ["email", "isnotempty", ""]
            ],
            columns: [
                search.createColumn({ name: "internalid", label: "Internal ID" }),
                search.createColumn({ name: "entityid",   label: "Name" }),
                search.createColumn({ name: "email",       label: "Email" })
            ]
        });
        emailAuthorSearch.run().each(function (result) {
            var empId    = result.getValue({ name: "internalid" });
            var empName  = result.getValue({ name: "entityid" });
            var empEmail = result.getValue({ name: "email" });

            // Don't mark these as default — default is owned by the class author / passedAuthor
            pushEmployee(empId, empName, empEmail, false);
            return true;
        });
        log.debug('employeeList after email authors', employeeList);
    } catch (e) {
        log.error('getEmployeeList email author search error', e);
    }



    return employeeList;
}

  function getEmailTemplates() {
    var list = [];
    try {
      search.create({
        type: 'emailtemplate',
        filters: [['isinactive', 'is', 'F']],
        columns: ['name', 'internalid']
      }).run().each(function (result) {
        list.push({
          id: String(result.getValue('internalid') || ''),
          name: String(result.getValue('name') || '')
        });
        return true;
      });
    } catch (e) {
      log.error('email template fetch error', e);
    }
    return list;
  }

  function getPreMergedTemplates(templateList, entityId, recId, recType) {
    var map = {};
    var isTxn = recType && recType !== 'invoicegroup';
    try {
        for (var i = 0; i < templateList.length; i++) {
            var t = templateList[i];
            try {
                var merged;
                try {
                    merged = render.mergeEmail({
                        templateId: Number(t.id),
                        transactionId: isTxn ? (Number(recId) || null) : null,
                        entityId: entityId ? Number(entityId) : null
                    });
                } catch (mergeErr) {
                    merged = render.mergeEmail({          // entity-only fallback (your existing fallback)
                        templateId: Number(t.id),
                        entityId: entityId ? Number(entityId) : null
                    });
                }
                map[String(t.id)] = {
                    subject: merged && merged.subject ? String(merged.subject) : '',
                    body:    merged && merged.body    ? String(merged.body)    : ''
                };
            } catch (innerErr) {
                log.error('template merge error for ' + t.id, innerErr);
                map[String(t.id)] = { subject: '', body: '' };
            }
        }
    } catch (e) {
        log.error('getPreMergedTemplates error', e);
    }
    return map;
}

  function addHiddenLongText(form, id, label, value) {
    var fld = form.addField({
      id: id,
      type: ui.FieldType.LONGTEXT,
      label: label
    });
    fld.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
    fld.defaultValue = value || '';
  }

  function addHiddenText(form, id, label, value) {
    var fld = form.addField({
      id: id,
      type: ui.FieldType.TEXT,
      label: label
    });
    fld.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
    fld.defaultValue = value || '';
  }

  function buildHtml() {
    return ''
      + '<style>'
      + 'html,body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif;height:100%;overflow:hidden;}'
      + 'body{color:#222;}'
      + ':root{--ns-blue:#375d8d;--ns-blue-dark:#2c4a6b;--ns-border:#c9cdd3;--ns-bg:#f6f7f9;--ns-label:#333;--ns-text:#222;}'
      + '#nsEmailRoot{height:100%;display:flex;flex-direction:column;background:#fff;margin:0;padding:0;overflow:hidden;}'
      + '#nsEmailCard{background:#fff;height:100%;display:flex;flex-direction:column;color:var(--ns-text);overflow:hidden;min-height:0;margin:0;padding:0;}'
      + '#nsEmailLoaderOverlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:1000000;}'
      + '#nsEmailLoaderBox{background:#fff;border-radius:8px;padding:18px 22px;box-shadow:0 16px 40px rgba(0,0,0,.35);display:flex;align-items:center;gap:12px;min-width:260px;}'
      + '#nsEmailLoaderSpinner{width:24px;height:24px;border:3px solid #e5e7eb;border-top-color:var(--ns-blue);border-radius:50%;animation:nsSpin 1s linear infinite;}'
      + '@keyframes nsSpin{to{transform:rotate(360deg);}}'
      + '#nsEmailLoaderText{font-weight:600;color:#333;}'
      + '#nsEmailToolbarTop,#nsEmailToolbarBottom{padding:8px 12px;border-bottom:1px solid var(--ns-border);display:flex;gap:8px;flex-wrap:wrap;background:#fff;flex:0 0 auto;}'
      + '#nsEmailToolbarBottom{border-top:1px solid var(--ns-border);border-bottom:none;}'
      + '.ns-btn{background:#fff;border:1px solid var(--ns-border);padding:6px 12px;border-radius:4px;cursor:pointer;}'
      + '.ns-btn.primary{background:linear-gradient(to bottom,#4d6784 0%,#3f566f 100%);border-color:var(--ns-blue-dark);color:#fff;}'
      + '.ns-tabs{background:var(--ns-blue);padding:0 10px;display:flex;gap:2px;flex:0 0 auto;}'
      + '.ns-tab{color:#fff;opacity:.9;padding:10px 14px;cursor:pointer;border-top-left-radius:4px;border-top-right-radius:4px;}'
      + '.ns-tab.active{background:#fff;color:#000;opacity:1;}'
      + '.ns-panels{background:#fff;flex:1 1 auto;border-top:none;padding:12px;overflow-y:auto;overflow-x:hidden;min-height:0;}'
      + '.ns-panel{display:none;}'
      + '.ns-panel.active{display:block;}'
      + '.ns-row{display:grid;grid-template-columns:220px 1fr;gap:12px;margin:8px 0;align-items:center;}'
      + '.ns-row label{color:var(--ns-label);font-weight:600;}'
      + '.ns-input,.ns-select,.ns-rich-text-body{width:100%;border:1px solid var(--ns-border);border-radius:3px;padding:6px 8px;font-size:13px;background:#fff;box-sizing:border-box;}'
      + '.ns-grid{border:1px solid var(--ns-border);border-radius:3px;overflow:auto;max-width:100%;}'
      + '.ns-grid table{width:100%;border-collapse:collapse;}'
      + '.ns-grid thead th{background:var(--ns-bg);border-bottom:1px solid var(--ns-border);text-align:left;font-weight:600;padding:8px;font-size:12px;position:sticky;top:0;z-index:1;}'
      + '.ns-grid tbody td{border-bottom:1px solid #eee;padding:6px 8px;font-size:12px;vertical-align:middle;}'
      + '.ns-rich-text-container{border:1px solid var(--ns-border);border-radius:3px;margin-top:6px;display:flex;flex-direction:column;min-height:300px;height:300px;overflow:hidden;}'
      + '.ns-rich-text-body{flex:1 1 auto;min-height:0;padding:10px;outline:none;border:none;overflow:auto;}'
      + '.ns-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}'
      + '<\/style>'

      + '<div id="nsEmailRoot">'
      + '  <div id="nsEmailCard">'
      + '    <form id="nsEmailForm" method="POST">'
      + '      <input type="hidden" name="custpage_email_payload" id="custpage_email_payload" />'

      + '      <div id="nsEmailToolbarTop">'
      + '        <button id="nsSendTop" type="button" class="ns-btn primary">Merge &amp; Send</button>'
      + '        <button id="nsCloseTop" type="button" class="ns-btn">Cancel</button>'
      + '      </div>'

      + '      <div class="ns-tabs">'
      + '        <div class="ns-tab active" data-tab="recipients">Recipients</div>'
      + '        <div class="ns-tab" data-tab="message">Message</div>'
      + '        <div class="ns-tab" data-tab="attachments">Attachments</div>'
      + '      </div>'

      + '      <div class="ns-panels">'
      + '        <div class="ns-panel active" id="panel-recipients">'
      + '          <div class="ns-row"><label for="nsEmployeeSel">Authors</label><select id="nsEmployeeSel" class="ns-select"></select></div>'
      + '          <div class="ns-row"><label for="nsRecipientSel">Recipient</label><select id="nsRecipientSel" class="ns-select"></select></div>'
      + '          <div class="ns-row"><label for="nsEmailTo">Email Address <span style="color:#c00">*</span></label><input id="nsEmailTo" class="ns-input" type="text" placeholder="primary@domain.com" /></div>'
      + '          <div style="font-size:12px;color:#666;margin:4px 0 10px;">Select existing recipients from the list below. To add new recipients, enter the email address into the email field. Click <b>Add</b> after each line.</div>'
      + '          <div class="ns-inline">'
      + '            <select id="nsAddRecRole" class="ns-select" style="width:100px;">'
      + '              <option value="TO" selected>TO</option>'
      + '              <option value="CC">CC</option>'
      + '              <option value="BCC">BCC</option>'
      + '            </select>'
      + '            <button class="ns-btn primary" type="button" id="nsAddRecipientBtn">Add</button>'
      + '            <button class="ns-btn" type="button" id="nsRemoveRecipientsBtn">Remove</button>'
      + '          </div>'
      + '          <div class="ns-grid" style="margin-top:10px">'
      + '            <table id="nsRecTable">'
      + '              <thead><tr><th style="width:26px"><input type="checkbox" id="nsRecCheckAll"></th><th>EMAIL <span style="color:#c00">*</span></th><th style="width:90px">TO</th><th style="width:90px">CC</th><th style="width:90px">BCC</th></tr></thead>'
      + '              <tbody></tbody>'
      + '            </table>'
      + '          </div>'
      + '        </div>'

      + '        <div class="ns-panel" id="panel-message">'
      + '          <div class="ns-row"><label>Template</label><div style="display:flex;gap:10px;align-items:center"><select class="ns-select" id="nsTpl"></select></div></div>'
      + '          <div class="ns-row"><label for="nsSubject">Subject <span style="color:#c00">*</span></label><input id="nsSubject" class="ns-input" type="text" /></div>'
      + '          <div class="ns-rich-text-container"><div class="ns-rich-text-body" id="nsBody" contenteditable="true"></div></div>'
      + '        </div>'

      + '        <div class="ns-panel" id="panel-attachments">'
      + '          <div class="ns-row"><label>Attach Document</label><div style="display:flex;gap:10px;align-items:center"><label style="font-weight:normal"><input id="nsIncTxn" type="checkbox" /> INCLUDE RECORD PDF</label></div></div>'
      + '          <div class="ns-row ns-inline"><input id="nsFilePicker" type="file" multiple style="display:none" /><button class="ns-btn primary" type="button" id="nsChooseFilesBtn">Choose file(s)&hellip;</button><button class="ns-btn" type="button" id="nsRemoveAttachmentsBtn">Remove</button></div>'
      + '          <div class="ns-grid"><table id="nsAttTable"><thead><tr><th style="width:26px"><input type="checkbox" id="nsAttCheckAll"></th><th>Name</th><th style="width:80px">Size KB</th><th style="width:180px">Modified</th><th>Type</th></tr></thead><tbody></tbody></table></div>'
      + '        </div>'
      + '      </div>'

      + '      <div id="nsEmailToolbarBottom">'
      + '        <button id="nsSendBottom" type="button" class="ns-btn primary">Merge &amp; Send</button>'
      + '        <button id="nsCloseBottom" type="button" class="ns-btn">Cancel</button>'
      + '      </div>'

      + '    </form>'
      + '  </div>'
      + '</div>'

      + '<div id="nsEmailLoaderOverlay" role="alert" aria-live="assertive">'
      + '  <div id="nsEmailLoaderBox"><div id="nsEmailLoaderSpinner"></div><div id="nsEmailLoaderText">Merging and sending&hellip;</div></div>'
      + '</div>';
  }

  function getFileType(fileName) {
    var name = String(fileName || '').toLowerCase();

    if (/\.pdf$/.test(name)) return file.Type.PDF;
    if (/\.txt$/.test(name)) return file.Type.PLAINTEXT;
    if (/\.csv$/.test(name)) return file.Type.CSV;
    if (/\.htm$|\.html$/.test(name)) return file.Type.HTMLDOC;
    if (/\.xml$/.test(name)) return file.Type.XMLDOC;
    if (/\.doc$/.test(name)) return file.Type.WORD;
    if (/\.docx$/.test(name)) return file.Type.WORD;
    if (/\.xls$/.test(name)) return file.Type.EXCEL;
    if (/\.xlsx$/.test(name)) return file.Type.EXCEL;
    if (/\.jpg$|\.jpeg$/.test(name)) return file.Type.JPGIMAGE;
    if (/\.png$/.test(name)) return file.Type.PNGIMAGE;
    if (/\.gif$/.test(name)) return file.Type.GIFIMAGE;
    if (/\.bmp$/.test(name)) return file.Type.BMPIMAGE;
    if (/\.zip$/.test(name)) return file.Type.ZIP;

    return file.Type.PLAINTEXT;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    onRequest: onRequest
  };
});