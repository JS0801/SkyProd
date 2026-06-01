/**
* @NApiVersion 2.1
* @NScriptType UserEventScript
*/
define(['N/ui/serverWidget', 'N/search', 'N/record', 'N/render', 'N/file', 'N/runtime', 'N/query', 'N/url'], (ui, search, record, render, file, runtime, query, url) => {
  
  function beforeLoad(context) {
    if (context.type !== context.UserEventType.VIEW) return;
    const form = context.form;
    
    const currRec = context.newRecord;
    const recId = currRec.id;
    const recType = currRec.type;

    // Invoice Groups do not have a class field
    const isInvoiceGroup = (recType === 'invoicegroup');
    const classID = isInvoiceGroup ? currRec.getValue('custrecord_invoicegroup_dba') : currRec.getValue('class');
    const custID = isInvoiceGroup ? currRec.getValue('customer') : currRec.getValue('entity');

    log.debug('Record Type', recType);
    log.debug('custID', custID);
    log.debug('classID', classID);
    
    var userId = runtime.getCurrentUser().id;
    var userEmail = runtime.getCurrentUser().email;
    var userName = runtime.getCurrentUser().name;
    log.debug('Current User', runtime.getCurrentUser());

    if (isInvoiceGroup) {
      form.clientScriptModulePath = './BPC_Sky_Email_invgrp_cs.js';

      

            var suiteletUrl = url.resolveScript({
                scriptId: 'customscript_bpc_sl_invoice_group_email',
                deploymentId: 'customdeploy_bpc_sl_invoice_group_email',
                returnExternalUrl: true,
                params: {
                    recid: String(recId || ''),
                    rectype: String(recType || ''),
                    custid: String(custID || ''),
                    classid: String(classID || ''),
                    authorid: String(userId || ''),
                    authorname: String(userName || ''),
                    authoremail: String(userEmail || '')
                }
            });

      var htmlFld = form.addField({
        id: 'custpage_invgrp_email_popup_html',
        type: ui.FieldType.INLINEHTML,
        label: 'Popup HTML'
      });
      htmlFld.defaultValue = buildPopupShellHtml();

            var fldUrl = form.addField({
                id: 'custpage_invgrp_email_sl',
                type: ui.FieldType.TEXTAREA,
                label: 'Email Popup URL'
            });
            fldUrl.updateDisplayType({
                displayType: ui.FieldDisplayType.HIDDEN
            });
            fldUrl.defaultValue = suiteletUrl || '';

            form.addButton({
                id: 'custpage_btn_email',
                label: 'Send Email',
                functionName: 'openInvoiceGroupEmailPopup'
            });
      return;
    }
    
    try {
      // --- 1) Add button
      form.addButton({
        id: 'custpage_btn_email',
        label: 'Send Email',
        functionName: 'window.openEmailModal'
      });
      
      // --- 2) Fetch customer data from NetSuite
      const customerList = [];

      if (custID) {
        var sql = "SELECT BUILTIN_RESULT.TYPE_INTEGER(entity.ID) AS ID, BUILTIN_RESULT.TYPE_STRING(entity.altname) AS altname, BUILTIN_RESULT.TYPE_STRING(entity.email) AS email FROM entity WHERE entity.email IS NOT NULL AND entity.ID =" + custID;

        var resultSet = query.runSuiteQL({query: sql});
        var resultsObj = resultSet.asMappedResults();
        if (resultsObj.length > 0) {
          var values = resultsObj[0];
          customerList.push({
            id: values.id,
            name: values.altname + " (" + values.email + ")",
            email: values.email
          });
        }
      }

      // Contact search — for Invoice Group, search contacts linked to the customer entity
      if (isInvoiceGroup && custID) {
        var contactSearchObj = search.create({
          type: "contact",
          filters: [
            ["company", "anyof", custID],
            "AND",
            ["email", "isnotempty", ""]
          ],
          columns: [
            search.createColumn({name: "internalid", label: "Internal ID"}),
            search.createColumn({name: "entityid", label: "Name"}),
            search.createColumn({name: "email", label: "Email"})
          ]
        });
        contactSearchObj.run().each(function(result) {
          log.debug('result', result);
          var contactID = result.getValue({name: "internalid"});
          var contactName = result.getValue({name: "entityid"});
          var contactEmail = result.getValue({name: "email"});

          customerList.push({
            id: contactID,
            name: contactName + " (" + contactEmail + ")",
            email: contactEmail
          });

          return true;
        });
      } else {
        // Original contact search for standard transactions (linked via transaction)
        var contactSearchObj = search.create({
          type: "contact",
          filters: [
            ["transaction.internalid", "anyof", recId],
            "AND",
            ["email", "isnotempty", ""]
          ],
          columns: [
            search.createColumn({name: "internalid", label: "Internal ID"}),
            search.createColumn({name: "entityid", label: "Name"}),
            search.createColumn({name: "email", label: "Email"})
          ]
        });
        contactSearchObj.run().each(function(result) {
          log.debug('result', result);
          var contactID = result.getValue({name: "internalid"});
          var contactName = result.getValue({name: "entityid"});
          var contactEmail = result.getValue({name: "email"});

          customerList.push({
            id: contactID,
            name: contactName + " (" + contactEmail + ")",
            email: contactEmail
          });

          return true;
        });
      }
      
      var employeeList = [];
      var defaultID = null;
      
      // Classification/Author lookup — only for records that have a class field
      if (!isInvoiceGroup) {
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
              label: "Internal ID"
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
        var searchResultCount = classificationSearchObj.runPaged().count;
        classificationSearchObj.run().each(function(result) {
          
          var listObj = {
            name: result.getValue({name: "entityid", join: "CUSTRECORD_BPC_EMAIL_AUTHOR"}),
            email: result.getValue({name: "email", join: "CUSTRECORD_BPC_EMAIL_AUTHOR"}),
            id: result.getValue({name: "internalid", join: "CUSTRECORD_BPC_EMAIL_AUTHOR"})
          };
          if (classID && classID == result.getValue({name: "internalid"})) {
            listObj.default = true;
            defaultID = result.getValue({name: "internalid", join: "CUSTRECORD_BPC_EMAIL_AUTHOR"});
          }
          employeeList.push(listObj);
          
          return true;
        });
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
    var empId = result.getValue({ name: "internalid" });

    // Skip the current user — they're added separately as the fallback author
    if (String(empId) === String(userId)) return true;

    // Skip anyone already in the list (e.g. pulled by the classification author lookup)
    var alreadyIn = employeeList.some(function (e) {
      return String(e.id) === String(empId);
    });
    if (alreadyIn) return true;

    employeeList.push({
      id:    empId,
      name:  result.getValue({ name: "entityid" }),
      email: result.getValue({ name: "email" })
    });

    return true;
  });
} catch (e) {
  log.error('Email Author Employee Search Error', e);
}
      // Always add the current user as a fallback author
var userAlreadyInList = employeeList.some(function (e) {
  return String(e.id) === String(userId);
});
if (!userAlreadyInList) {
  var obj = {
    name: userName,
    email: userEmail,
    id: userId
  };
  if (!defaultID) obj.default = true;
  employeeList.push(obj);
}
      
      
      if (employeeList.length == 0) return;
      
      log.debug('employeeList', employeeList);
      
      const emailTemplateList = [];
      try {
        search.create({
          type: 'emailtemplate',
          filters: [
            ["isinactive", "is", "F"]
          ],
          columns: [
            'name',
            'internalid'
          ]
        }).run().each(function(result) {
          emailTemplateList.push({
            id: result.getValue('internalid'),
            name: result.getValue('name')
          });
          return true;
        });
      } catch (e) {
        log.error({
          title: 'Email Template Search Error',
          details: e
        });
      }
      
      // --- Pre-merge all templates server-side (once) ---
      const preMergedById = {};
      try {
        const txnId = context.newRecord.id;
        const entityId = custID;
        
        emailTemplateList.forEach(t => {
          try {
            // For Invoice Group, we may not be able to pass transactionId
            // since render.mergeEmail may not support invoicegroup type.
            // We still attempt it; if it fails, we fall back to entity-only merge.
            let merged;
            try {
              merged = render.mergeEmail({
                templateId: Number(t.id),
                transactionId: isInvoiceGroup ? null : (Number(txnId) || null),
                entityId: Number(entityId) || null
              });
            } catch (mergeErr) {
              // Fallback: merge with entity only (no transaction context)
              log.debug('Merge fallback for template ' + t.id, mergeErr.message);
              merged = render.mergeEmail({
                templateId: Number(t.id),
                entityId: Number(entityId) || null
              });
            }
            preMergedById[String(t.id)] = {
              subject: merged.subject || '',
              body: merged.body || ''
            };
          } catch (e) {
            log.error('Template merge error for ' + t.id, e);
            preMergedById[String(t.id)] = { subject: '', body: '' };
          }
        });
      } catch (e) {
        log.error('Pre-merge block failed', e);
      }
      
      const preMergedJson = JSON.stringify(preMergedById);
      
      const customerDataJson = JSON.stringify(customerList);
      const emailTemplateDataJson = JSON.stringify(emailTemplateList);
      const employeeDataJson = JSON.stringify(employeeList);
      
      log.debug('customerDataJson', customerDataJson);
      log.debug('emailTemplateDataJson', emailTemplateDataJson);
      log.debug('employeeDataJson', employeeDataJson);
      
      // --- 3) Add inline HTML (popup markup + script)
      const fld = form.addField({
        id: 'custpage_email_html',
        type: ui.FieldType.INLINEHTML,
        label: 'Email HTML'
      });
      
      const recordId = context.newRecord.id;
      
      // Pass record type and isInvoiceGroup flag to the client
      const recTypeStr = JSON.stringify(recType);
      
      fld.defaultValue = `
      <style>
      /* Updated NetSuite-like color palette */
      :root{
        --ns-blue:#375d8d;
        --ns-blue-dark:#2c4a6b;
        --ns-border:#c9cdd3;
        --ns-bg:#f6f7f9;
        --ns-label:#333;
        --ns-text:#222;
      }
      
      /* Modal layout and styling */
      #nsEmailOverlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:999999;}
      #nsEmailCard{
        background:#fff;
        width:980px;
        max-width:98vw;
        height:85vh;
        overflow: auto;
        border-radius:8px;
        box-shadow:0 16px 40px rgba(0,0,0,.35);
        font-family:inherit;
        color:var(--ns-text);
        display:flex;
        flex-direction:column;
      }
      
      /* Loader overlay */
      #nsEmailLoaderOverlay{
        position:fixed; inset:0; display:none;
        align-items:center; justify-content:center;
        background:rgba(0,0,0,.55); z-index:1000000;
      }
      #nsEmailLoaderBox{
        background:#fff; border-radius:8px; padding:18px 22px;
        box-shadow:0 16px 40px rgba(0,0,0,.35);
        display:flex; align-items:center; gap:12px; min-width:260px;
      }
      #nsEmailLoaderSpinner{
        width:24px; height:24px; border:3px solid #e5e7eb;
        border-top-color:var(--ns-blue); border-radius:50%;
        animation:nsSpin 1s linear infinite;
      }
      @keyframes nsSpin{ to { transform:rotate(360deg); } }
      #nsEmailLoaderText{font-weight:600; color:#333}
      
      
      /* Header and close button */
      #nsEmailHeader{
        padding:12px 16px;
        border-bottom:1px solid var(--ns-border);
        display:flex;
        align-items:center;
        gap:10px;
      }
      #nsEmailHeader .title{font-size:18px;font-weight:600}
      #nsEmailClose{
        margin-left:auto;
        font-size:18px;
        line-height:18px;
        background:transparent;
        border:none;
        cursor:pointer;
        color:#666;
      }
      
      /* Toolbars */
      #nsEmailToolbarTop, #nsEmailToolbarBottom{
        padding:10px 16px;
        border-bottom:1px solid var(--ns-border);
        display:flex;
        gap:8px;
      }
      #nsEmailToolbarBottom{
        border-top:1px solid var(--ns-border);
        border-bottom:none;
      }
      
      /* Buttons */
      .ns-btn{
        background:#fff;
        border:1px solid var(--ns-border);
        padding:6px 12px;
        border-radius:4px;
        cursor:pointer;
      }
      .ns-btn.primary{
        background:var(--ns-blue);
        background:linear-gradient(to bottom, #4d6784 0%, #3f566f 100%);
        border-color:var(--ns-blue-dark);
        color:#fff;
        font-weight:600;
      }
      .ns-btn:hover{filter:brightness(0.98)}
      
      /* Tabs */
      .ns-tabs{
        background:var(--ns-blue);
        padding:0 10px;
        display:flex;
        gap:2px;
      }
      .ns-tab{
        color:#fff;
        opacity:.9;
        padding:10px 14px;
        cursor:pointer;
        border-top-left-radius:4px;
        border-top-right-radius:4px;
      }
      .ns-tab.active{background:#fff;color:#000;opacity:1}
      
      /* Panels */
      .ns-panels{
        background:#fff;
        flex-grow:1;
        border:1px solid var(--ns-border);
        border-top:none;
        padding:16px;
        overflow-y:auto;
      }
      .ns-panel{display:none}
      .ns-panel.active{display:block}
      
      /* Form elements */
      .ns-row{display:grid;grid-template-columns:220px 1fr;gap:12px;margin:10px 0;align-items:center}
      .ns-row label{color:var(--ns-label);font-weight:600}
      .ns-input, .ns-select, .ns-textarea, .ns-rich-text-body{width:100%;border:1px solid var(--ns-border);border-radius:3px;padding:6px 8px;font-size:13px;background:#fff}
      .ns-textarea{min-height:160px}
      .ns-help{font-size:12px;color:#666;margin:4px 0 10px}
      
      /* Grid */
      .ns-grid{border:1px solid var(--ns-border);border-radius:3px;overflow:hidden}
      .ns-grid table{width:100%;border-collapse:collapse}
      .ns-grid thead th{background:var(--ns-bg);border-bottom:1px solid var(--ns-border);text-align:left;font-weight:600;padding:8px;font-size:12px}
      .ns-grid tbody td{border-bottom:1px solid #eee;padding:6px 8px;font-size:12px}
      .ns-grid tfoot td{background:#fafafa;padding:8px;border-top:1px solid var(--ns-border)}
      .ns-row.inline{grid-template-columns:1fr auto auto auto auto;gap:8px}
      .ns-pill{display:inline-block;border:1px solid var(--ns-border);padding:2px 8px;border-radius:16px;font-size:12px;margin-right:6px}
      
      /* Rich Text Editor Styling */
      .ns-rich-text-container {
        border: 1px solid var(--ns-border);
        border-radius: 3px;
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .ns-toolbar-body {
        padding: 4px;
        border-bottom: 1px solid var(--ns-border);
        background: var(--ns-bg);
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
      }
      .ns-toolbar-group {
        display: flex;
        gap: 4px;
        align-items: center;
        margin-right: 8px;
        padding: 0 4px;
      }
      .ns-toolbar-btn {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-weight: bold;
        border-radius: 3px;
        font-size: 14px;
      }
      .ns-toolbar-btn:hover {
        background: #e0e0e0;
      }
      .ns-rich-text-body {
        flex-grow: 1;
        padding: 8px;
        border: none;
        border-top: 1px solid var(--ns-border);
        outline: none;
        line-height: 1.5;
        font-family: inherit;
      }
      .ns-dropdown-btn {
        display: flex;
        align-items: center;
        border: 1px solid #d0d0d0;
        border-radius: 3px;
        padding: 2px 4px;
        background: #fff;
        cursor: pointer;
      }
      .ns-dropdown-btn span {
        margin-right: 4px;
      }
      .ns-dropdown-btn:hover {
        background: #f0f0f0;
      }
      .ns-separator {
        width: 1px;
        background: #d0d0d0;
        margin: 0 4px;
      }
      </style>
      
      <div id="nsEmailOverlay" role="dialog" aria-modal="true">
      <div id="nsEmailCard">
      <div id="nsEmailHeader">
      <div class="title">Email Message</div>
      <button id="nsEmailClose" type="button" onclick="closeEmailModal()">✖</button>
      </div>
      
      <div id="nsEmailToolbarTop">
      <button class="ns-btn primary" id="nsSendTop" type="button" onclick="nsMergeSend()">Merge &amp; Send</button>
      <button class="ns-btn" type="button" onclick="closeEmailModal()">Cancel</button>
      </div>
      
      <div class="ns-tabs">
      <div class="ns-tab active" data-tab="recipients" onclick="nsSwitchTab('recipients')">Recipients</div>
      <div class="ns-tab" data-tab="message" onclick="nsSwitchTab('message')">Message</div>
      <div class="ns-tab" data-tab="attachments" onclick="nsSwitchTab('attachments')">Attachments</div>
      </div>
      
      <div class="ns-panels">
      <div class="ns-panel active" id="panel-recipients">
      <div class="ns-row">
      <label for="nsEmployeeSel">Authors</label>
      <select id="nsEmployeeSel" class="ns-select">
      </select>
      </div>
      
      <div class="ns-row">
      <label for="nsRecipientSel">Recipient</label>
      <select id="nsRecipientSel" class="ns-select">
      <option value="">- Select -</option>
      </select>
      </div>
      
      <div class="ns-row">
      <label for="nsEmailTo">Email Address <span style="color:#c00">*</span></label>
      <input id="nsEmailTo" class="ns-input" type="text" placeholder="primary@domain.com">
      </div>
      
      <div class="ns-help">
      Select existing recipients from the list below. To add new recipients, enter the email address into the email field. Click <b>Add</b> after each line.
      </div>
      
      <div>
      <select id="nsAddRecRole" class="ns-select" style="width:100px; margin-left: 10px;">
      <option value="TO" selected>TO</option>
      <option value="CC">CC</option>
      <option value="BCC">BCC</option>
      </select>
      <button class="ns-btn primary" type="button" onclick="nsAddRecipient()">Add</button>
      <button class="ns-btn" type="button" onclick="nsRemoveSelectedRecipients()">Remove</button>
      </div>
      
      <div class="ns-grid" style="margin-top:10px">
      <table id="nsRecTable">
      <thead>
      <tr>
      <th style="width:26px"><input type="checkbox" onclick="nsToggleAll(this,'nsRecTable')"></th>
      <th>EMAIL <span style="color:#c00">*</span></th>
      <th style="width:90px">TO</th>
      <th style="width:90px">CC</th>
      <th style="width:90px">BCC</th>
      </tr>
      </thead>
      <tbody></tbody>
      <tfoot>
      <tr><td colspan="5"> </td></tr>
      </tfoot>
      </table>
      </div>
      </div>
      
      <div class="ns-panel" id="panel-message">
      <div class="ns-row">
      <label>Template</label>
      <div style="display:flex;gap:10px;align-items:center">
      <select class="ns-select" id="nsTpl"></select>
      </label>
      </div>
      </div>
      
      <div class="ns-row">
      <label for="nsSubject">Subject <span style="color:#c00">*</span></label>
      <input id="nsSubject" class="ns-input">
      </div>
      
      <div class="ns-rich-text-container">
      <div class="ns-rich-text-body" id="nsBody" contenteditable="true"></div>
      </div>
      </div>
      
      <div class="ns-panel" id="panel-attachments">
      <div class="ns-row">
      <label>Attach Document </label>
      <div style="display:flex;gap:10px;align-items:center">
      <label style="font-weight:normal">
      <input id="nsIncTxn" type="checkbox"> INCLUDE RECORD PDF
      </label>
      </div>
      </div>
      
      <div class="ns-row inline">
      <input id="nsFilePicker" type="file" multiple style="display:none" />
      <button class="ns-btn primary" type="button" onclick="nsOpenFilePicker()">Choose file(s)…</button>
      <button class="ns-btn" type="button" onclick="nsRemoveSelectedAttachments()">Remove</button>
      </div>
      
      <div id="nsEmailLoaderOverlay" role="alert" aria-live="assertive">
      <div id="nsEmailLoaderBox">
      <div id="nsEmailLoaderSpinner"></div>
      <div id="nsEmailLoaderText">Merging and sending…</div>
      </div>
      </div>
      
      
      <div class="ns-grid" style="margin-top:10px">
      <table id="nsAttTable">
      <thead>
      <tr>
      <th style="width:26px"><input type="checkbox" onclick="nsToggleAll(this,'nsAttTable')"></th>
      <th>ATTACH FILE <span style="color:#c00">*</span></th>
      <th>FOLDER</th>
      <th>SIZE (KB)</th>
      <th>LAST MODIFIED</th>
      <th>FILE TYPE</th>
      </tr>
      </thead>
      <tbody></tbody>
      </table>
      </div>
      </div>
      </div>
      
      <div id="nsEmailToolbarBottom">
      <button class="ns-btn primary" id="nsSendBottom" type="button" onclick="nsMergeSend()">Merge &amp; Send</button>
      <button class="ns-btn" type="button"  onclick="closeEmailModal()">Cancel</button>
      </div>
      </div>
      </div>
      
      <script>
      (function (w) {
        // Store the record ID and type for the RESTlet
        w.nsRecordId = ` + recordId + `;
        w.nsRecordType = ${recTypeStr};
        w.nsAccountUrl = window.location.protocol + '//' + window.location.hostname;
        
        const customers = JSON.parse(\`${customerDataJson}\`);
        const emailTemplates = JSON.parse(\`${emailTemplateDataJson}\`);
        const employees = JSON.parse(\`${employeeDataJson}\`);
        const preMerged = ${preMergedJson}
        w.__PREMERGED_EMAIL__ = preMerged;
        
        // Populate the dropdown with customer data
        const addRecSelect = document.getElementById('nsRecipientSel');
        if (addRecSelect) {
          customers.forEach(customer => {
            const option = document.createElement('option');
            option.value = customer.name;
            option.textContent = customer.name;
            addRecSelect.appendChild(option);
          });
          
          addRecSelect.addEventListener('change', function() {
            const selectedId = this.value;
            console.log('selectedId', selectedId);
            if (!selectedId) return;
            
            const selectedCustomer = customers.find(c => c.name == selectedId);
            console.log('selectedCustomer', selectedCustomer);
            if (selectedCustomer && selectedCustomer.email) {
              const emailInput = document.getElementById('nsEmailTo');
              if (emailInput) {
                emailInput.value = selectedCustomer.email;
                emailInput.focus();
              }
            }
          });
        }
        
        const primaryCustomer = customers.find(c => c.email && c.email.trim() !== '');
        if (primaryCustomer) {
          const emailInput = document.getElementById('nsEmailTo');
          if (emailInput) {
            emailInput.value = primaryCustomer.email;
            
            const tableBody = document.querySelector('#nsRecTable tbody');
            
            const newRow = tableBody.insertRow();
            const checkboxCell = newRow.insertCell();
            const emailCell = newRow.insertCell();
            const toCell = newRow.insertCell();
            const ccCell = newRow.insertCell();
            const bccCell = newRow.insertCell();
            
            checkboxCell.innerHTML = '<input type="checkbox">';
            emailCell.textContent = primaryCustomer.email;
            toCell.textContent = '✔';
            ccCell.textContent = '';
            bccCell.textContent = '';
            
            newRow.setAttribute('data-email', primaryCustomer.email);
          }
        }
        
        // Populate Employee (Author) - value is INTERNAL ID
        const employeeInput = document.getElementById('nsEmployeeSel');
        if (employeeInput) {
          employees.forEach(emp => {
            const option = document.createElement('option');
            option.value = String(emp.id);
            option.textContent = emp.name + (emp.email ? ' (' + emp.email + ')' : '');
            
            if (emp.default === true) option.selected = true;
            employeeInput.appendChild(option);
          });
        }
        
        
        // Populate the email template dropdown
        const templateSelect = document.getElementById('nsTpl');
        if (templateSelect) {
          const defaultOption = document.createElement('option');
          defaultOption.value = '';
          defaultOption.textContent = '- Select -';
          templateSelect.appendChild(defaultOption);
          
          emailTemplates.forEach(template => {
            const option = document.createElement('option');
            option.value = template.id;
            option.textContent = template.name;
            templateSelect.appendChild(option);
          });
          
          templateSelect.addEventListener('change', function () {
            const templateId = this.value;
            if (!templateId) return;
            
            console.log("Selected Template ID:", templateId);
            
            const store = (window.__PREMERGED_EMAIL__ || {});
            const entry = store[String(templateId)] || { subject: '', body: '' };
            
            console.log('body', entry.body)
            console.log('subject', entry.subject)
            
            document.getElementById('nsSubject').value = entry.subject || '';
            document.getElementById('nsBody').innerHTML = entry.body || '';
          });
        }
        
        // Public function to open the modal
        w.openEmailModal = function(){
          var o = document.getElementById('nsEmailOverlay');
          if (!o) { alert('Email UI not loaded yet.'); return; }
          o.style.display = 'flex';
          var to = document.getElementById('nsEmailTo');
          if (to && to.focus) { setTimeout(function(){ to.focus(); }, 10); }
          document.addEventListener('keydown', w.nsEscCloseOnce, { once: true });
        };
        
        // Public function to close the modal
        w.closeEmailModal = function(){
          var modal = document.getElementById('nsEmailOverlay');
          if (modal) {
            modal.style.display = 'none';
          }
        };
        
        // Close modal with the Escape key
        w.nsEscCloseOnce = function(e){ 
          if (e.key === 'Escape') {
            w.closeEmailModal();
          }
        };
        
        // Tab switching logic
        w.nsSwitchTab = function(tabName) {
          document.querySelectorAll('.ns-tab').forEach(function(tab) {
            tab.classList.remove('active');
          });
          document.querySelectorAll('.ns-panel').forEach(function(panel) {
            panel.classList.remove('active');
          });
          
          const selectedTab = document.querySelector('.ns-tab[data-tab="' + tabName + '"]');
          const selectedPanel = document.getElementById('panel-' + tabName);
          
          if (selectedTab) selectedTab.classList.add('active');
          if (selectedPanel) selectedPanel.classList.add('active');
        };
        
        // Rich Text Editor functionality
        w.nsApplyFormat = function(command, value) {
          document.execCommand(command, false, value);
        };
        
        w.nsCreateLink = function() {
          const url = prompt('Enter the URL:', 'https://');
          if (url) {
            document.execCommand('createLink', false, url);
          }
        };
        
        // ----------------------------------------------
        // File picker + attachment table management
        // ----------------------------------------------
        w.nsPickedFiles = [];
        
        w.nsOpenFilePicker = function () {
          var fp = document.getElementById('nsFilePicker');
          if (!fp) return;
          fp.value = '';
          fp.onchange = function (e) {
            var files = Array.from(e.target.files || []);
            if (!files.length) return;
            w.nsReadAndAppendFiles(files);
          };
          fp.click();
        };
        
        w.nsReadAndAppendFiles = function (files) {
          (function next(i){
            if (i >= files.length) return;
            var f = files[i];
            if (f.size > 15 * 1024 * 1024) {
              alert('Skipping "' + f.name + '" (over 15MB).');
              return next(i+1);
            }
            var rdr = new FileReader();
            rdr.onload = function (ev) {
              var dataUrl = String(ev.target.result || '');
              var entry = {
                name: f.name,
                type: f.type || 'application/octet-stream',
                size: f.size,
                lastModified: f.lastModified || Date.now(),
                dataUrl: dataUrl
              };
              w.nsPickedFiles.push(entry);
              w.nsAppendAttachmentRow(entry);
              next(i+1);
            };
            rdr.onerror = function () {
              alert('Could not read file: ' + f.name);
              next(i+1);
            };
            rdr.readAsDataURL(f);
          })(0);
        };
        
        w.nsAppendAttachmentRow = function (fileEntry) {
          var tbody = document.querySelector('#nsAttTable tbody');
          if (!tbody) return;
          var tr = tbody.insertRow();
          var td0 = tr.insertCell(), td1 = tr.insertCell(), td2 = tr.insertCell(),
          td3 = tr.insertCell(), td4 = tr.insertCell(), td5 = tr.insertCell();
          
          td0.innerHTML = '<input type="checkbox">';
          td1.textContent = fileEntry.name;
          td2.textContent = 'Email Dropbox';
          td3.textContent = Math.round(fileEntry.size / 1024);
          td4.textContent = new Date(fileEntry.lastModified).toLocaleString();
          td5.textContent = fileEntry.type;
          
          tr.setAttribute('data-fname', fileEntry.name + '|' + fileEntry.size);
        };
        
        w.nsRemoveSelectedAttachments = function () {
          var tbody = document.querySelector('#nsAttTable tbody');
          if (!tbody) return;
          var rows = Array.from(tbody.querySelectorAll('tr'));
          var toRemove = [];
          rows.forEach(function (r) {
            var cb = r.querySelector('input[type="checkbox"]');
            if (cb && cb.checked) {
              toRemove.push(r.getAttribute('data-fname'));
              r.remove();
            }
          });
          if (toRemove.length) {
            w.nsPickedFiles = w.nsPickedFiles.filter(function (f) {
              return toRemove.indexOf(f.name + '|' + f.size) === -1;
            });
          }
        };
        
        
        // ----------------------------------------------------
        // Updated Recipient & Attachment functions
        // ----------------------------------------------------
        w.nsAddRecipient = function() {
          const emailInput = document.getElementById('nsEmailTo');
          const emailValue = emailInput.value.trim();
          
          const roleSelect = document.getElementById('nsAddRecRole');
          const role = roleSelect.value;
          const tableBody = document.querySelector('#nsRecTable tbody');
          
          if (!emailValue) {
            alert('Please enter an email address.');
            return;
          }
          
          const existingEmails = Array.from(tableBody.querySelectorAll('td:nth-child(2)'))
          .map(td => td.textContent.trim());
          if (existingEmails.includes(emailValue)) {
            alert('This recipient has already been added.');
            return;
          }
          
          const newRow = tableBody.insertRow();
          const checkboxCell = newRow.insertCell();
          const emailCell = newRow.insertCell();
          const toCell = newRow.insertCell();
          const ccCell = newRow.insertCell();
          const bccCell = newRow.insertCell();
          
          checkboxCell.innerHTML = '<input type="checkbox">';
          emailCell.textContent = emailValue;
          toCell.textContent = role === 'TO' ? '✔' : '';
          ccCell.textContent = role === 'CC' ? '✔' : '';
          bccCell.textContent = role === 'BCC' ? '✔' : '';
          
          newRow.setAttribute('data-email', emailValue);
          
          emailInput.value = '';
          roleSelect.value = 'TO';
          emailInput.focus();
        };
        
        w.nsCancelRecipient = function(){
          const emailInput = document.getElementById('nsEmailTo');
          emailInput.value = '';
          emailInput.focus();
        };
        
        w.nsRemoveSelectedRecipients = function() {
          const tableBody = document.querySelector('#nsRecTable tbody');
          const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]');
          
          for (let i = checkboxes.length - 1; i >= 0; i--) {
            if (checkboxes[i].checked) {
              checkboxes[i].closest('tr').remove();
            }
          }
        };
        
        w.nsToggleAll = function(box, tableId) {
          const table = document.getElementById(tableId);
          if (!table) return;
          const isChecked = box.checked;
          const checkboxes = table.querySelectorAll('tbody input[type="checkbox"]');
          checkboxes.forEach(cb => {
            cb.checked = isChecked;
          });
        };
        
        w.nsAddAttachment = function(){};
        w.nsClearAttachments = function(){};
        w.nsPreview = function(){};
        
        // Show/hide + update text
        w.nsShowLoader = function (text) {
          var o = document.getElementById('nsEmailLoaderOverlay');
          if (!o) return;
          var t = document.getElementById('nsEmailLoaderText');
          if (t) t.textContent = text || 'Working…';
          o.style.display = 'flex';
          var topBtn = document.getElementById('nsSendTop');
          var botBtn = document.getElementById('nsSendBottom');
          if (topBtn) topBtn.disabled = true;
          if (botBtn) botBtn.disabled = true;
        };
        w.nsSetLoaderText = function (text) {
          var t = document.getElementById('nsEmailLoaderText');
          if (t) t.textContent = text;
        };
        w.nsHideLoader = function () {
          var o = document.getElementById('nsEmailLoaderOverlay');
          if (o) o.style.display = 'none';
          var topBtn = document.getElementById('nsSendTop');
          var botBtn = document.getElementById('nsSendBottom');
          if (topBtn) topBtn.disabled = false;
          if (botBtn) botBtn.disabled = false;
        };
        
        w.nsMergeSend = function () {
          w.nsShowLoader('Preparing email…');
          
          requestAnimationFrame(function () {
            try {
              const authorSel = document.getElementById('nsEmployeeSel');
              const authorId  = authorSel ? authorSel.value : '';
              if (!authorId) {
                w.nsHideLoader();
                alert('Please select an Author.');
                return;
              }
              
              const tableBody = document.querySelector('#nsRecTable tbody');
              const recipients = [];
              tableBody.querySelectorAll('tr').forEach(row => {
                const email = row.getAttribute('data-email');
                const to  = row.cells[2].textContent === '✔';
                const cc  = row.cells[3].textContent === '✔';
                const bcc = row.cells[4].textContent === '✔';
                if (email) recipients.push({ email, to, cc, bcc });
              });
              if (!recipients.length) {
                w.nsHideLoader();
                alert('Please add at least one recipient.');
                return;
              }
              
              const subject = (document.getElementById('nsSubject').value || '').trim();
              if (!subject) {
                w.nsHideLoader();
                alert('Please enter a subject.');
                return;
              }
              
              w.nsSetLoaderText('Collecting attachments…');
              
              var attachments = (w.nsPickedFiles || []).map(function (f) {
                var idx = String(f.dataUrl || '').indexOf('base64,');
                var b64 = idx > -1 ? f.dataUrl.substring(idx + 7) : '';
                return {
                  name: f.name,
                  type: f.type || 'application/octet-stream',
                  size: f.size,
                  base64: b64
                };
              });
              
              const includeTransaction = document.getElementById('nsIncTxn').checked;
              const bodyHtml = document.getElementById('nsBody').innerHTML;
              
              const payload = {
                author: Number(authorId),
                recordId: w.nsRecordId,
                recordType: w.nsRecordType,   // <-- pass record type to RESTlet
                subject: subject,
                body: bodyHtml,
                recipients: recipients,
                includeTransaction: includeTransaction,
                attachments: attachments
              };
              
              w.nsSetLoaderText('Sending email…');
              
              fetch('/app/site/hosting/restlet.nl?script=3030&deploy=1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(payload)
              })
              .then(function (res) {
                w.nsSetLoaderText('Processing response…');
                return res.json();
              })
              .then(function (response) {
                if (response && response.success) {
                  alert('Email sent successfully!');
                  w.closeEmailModal();
                  window.location.reload();
                } else {
                  var msg = (response && (response.message || response.error)) || 'Unknown error';
                  alert('Failed to send email: ' + JSON.stringify(msg));
                }
              })
              .catch(function (err) {
                console.error('Error sending email:', err);
                alert('Error sending email. Check logs.');
              })
              .finally(function () {
                w.nsHideLoader();
              });
              
            } catch (e) {
              w.nsHideLoader();
              console.error('nsMergeSend fatal error:', e);
              alert('Unexpected error. Check logs.');
            }
          });
        };
        
        
        
        // Utility function
        w.nsEsc = function(s){ return s.replace(/[&<>"]/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]); }); };
      })(window);
      </script>
      `;
      
      
    } catch (e) {
      log.error('error', e)
    }
  }

   function buildPopupShellHtml() {
    return ''
      + '<style>'
      + '#bpcInvGrpEmailOverlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:999999;}'
      + '#bpcInvGrpEmailModal{width:1100px;max-width:96vw;height:85vh;background:#fff;border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column;}'
      + '#bpcInvGrpEmailHeader{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #d5d9de;background:#f7f8fa;font-family:Arial,sans-serif;}'
      + '#bpcInvGrpEmailHeaderTitle{font-size:16px;font-weight:600;color:#222;}'
      + '#bpcInvGrpEmailClose{border:none;background:transparent;font-size:18px;cursor:pointer;color:#666;}'
      + '#bpcInvGrpEmailFrameWrap{flex:1;min-height:0;background:#fff;}'
      + '#bpcInvGrpEmailFrame{width:100%;height:100%;border:none;background:#fff;}'
      + '</style>'
      + '<div id="bpcInvGrpEmailOverlay">'
      + '  <div id="bpcInvGrpEmailModal">'
      + '    <div id="bpcInvGrpEmailHeader">'
      + '      <div id="bpcInvGrpEmailHeaderTitle">Send Email</div>'
      + '      <button type="button" id="bpcInvGrpEmailClose">&#10006;</button>'
      + '    </div>'
      + '    <div id="bpcInvGrpEmailFrameWrap">'
      + '      <iframe id="bpcInvGrpEmailFrame" src="about:blank"></iframe>'
      + '    </div>'
      + '  </div>'
      + '</div>';
  }
  
  return { beforeLoad };
});
