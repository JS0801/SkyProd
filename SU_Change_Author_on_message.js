/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function(record, search, log) {

  function beforeSubmit(context) {
    if (context.type !== context.UserEventType.CREATE) return;
     log.debug("context",context)
    var messageRec = context.newRecord;
    log.debug("messageRec",messageRec)
    var originalAuthor = messageRec.getValue('author');
    var transactionId = messageRec.getValue('transaction');

    log.debug('Original Author', originalAuthor);
    log.debug('Linked Transaction ID', transactionId);

    if (!transactionId) {
      log.debug('No transaction linked', 'Skipping author update');
      return;
    }

    try {
      // Try to get class from the transaction AS Sales Order
      var tranFields = search.lookupFields({
        type: search.Type.SALES_ORDER,
        id: transactionId,
        columns: ['class']
      });

      var classId = tranFields.class && tranFields.class.length > 0
        ? parseInt(tranFields.class[0].value, 10)
        : null;

      log.debug('Class ID from Sales Order', classId);

      // Hardcoded class-to-author mapping
      var classToAuthorMap = {
        1: 158,
        2: 159,
        3: 160
      };

      var newAuthorId = classToAuthorMap[classId];

      if (newAuthorId) {
        messageRec.setValue({
          fieldId: 'author',
          value: newAuthorId
        });

        log.debug('Author updated', `Old Author: ${originalAuthor}, New Author: ${newAuthorId}`);
      } else {
        log.debug('No matching author for class ID', classId);
      }

    } catch (e) {
      // If it's not a Sales Order, this will fail — and we skip
      log.debug('Transaction is not a Sales Order or lookup failed', e.message);
    }
  }

  return {
    beforeSubmit: beforeSubmit
  };
});
