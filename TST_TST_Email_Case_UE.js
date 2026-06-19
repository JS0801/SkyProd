/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Deployed on: Support Case (VIEW only, Testing status)
 * Adds Send Email button that opens the Case email Suitelet popup.
 *
 * AFTER uploading this file and creating the Suitelet (BPC_SL_Case_Email.js),
 * update scriptId and deploymentId below to match what NetSuite assigns.
 */
define(['N/ui/serverWidget', 'N/url', 'N/runtime'], function (ui, url, runtime) {

  function beforeLoad(context) {
    try {
      if (context.type !== context.UserEventType.VIEW) return;

      var form    = context.form;
      var rec     = context.newRecord;
      var currUser = runtime.getCurrentUser();

      // Cases use 'company' for the customer field (not 'entity')
      var custID = rec.getValue('company');
      var recId  = rec.id;

      // Reuse the existing popup shell client script — no changes needed there
      form.clientScriptModulePath = './BPC_Sky_Email_invgrp_cs.js';

      var suiteletUrl = url.resolveScript({
        scriptId:     'customscript4130',
        deploymentId: 'customdeploy1',
        returnExternalUrl: false,
        params: {
          recid:       String(recId    || ''),
          rectype:     'supportcase',
          custid:      String(custID   || ''),
          classid:     '',
          authorid:    String(currUser.id    || ''),
          authorname:  String(currUser.name  || ''),
          authoremail: String(currUser.email || '')
        }
      });

      log.debug('Case suiteletUrl', suiteletUrl);

      // Must use the same field ID the client script reads: custpage_invgrp_email_sl
      var fldUrl = form.addField({
        id:    'custpage_invgrp_email_sl',
        type:  ui.FieldType.TEXTAREA,
        label: 'Email Popup URL'
      });
      fldUrl.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
      fldUrl.defaultValue = suiteletUrl || '';

      var htmlFld = form.addField({
        id:    'custpage_invgrp_email_popup_html',
        type:  ui.FieldType.INLINEHTML,
        label: 'Popup HTML'
      });
      htmlFld.defaultValue = buildPopupShellHtml();

      form.addButton({
        id:           'custpage_btn_email',
        label:        'Send Email',
        functionName: 'openInvoiceGroupEmailPopup'
      });

    } catch (e) {
      log.error('Case beforeLoad error', e);
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

  return { beforeLoad: beforeLoad };
});
