/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define([], () => {

    const SUBLIST = 'recmachcustrecord_bpc_planning_job';
    const FLD_OVERRIDE = 'custrecord_override_machine';
    const FLD_MACHINE = 'custrecord_bpc_planning_machine';

    function pageInit(context) {
        const lineCount = context.currentRecord.getLineCount({ sublistId: SUBLIST });
        for (let i = 0; i < lineCount; i++) {
            const isOverride = context.currentRecord.getSublistValue({
                sublistId: SUBLIST,
                fieldId: FLD_OVERRIDE,
                line: i
            });
        }
    }

    function lineInit(context) {
        if (context.sublistId !== SUBLIST) return;
        const rec = context.currentRecord;
        const isOverride = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_OVERRIDE
        });
        rec.getCurrentSublistField({
            sublistId: SUBLIST,
            fieldId: FLD_MACHINE
        }).isDisabled = !isOverride;
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST || context.fieldId !== FLD_OVERRIDE) return;
        const rec = context.currentRecord;
        const isOverride = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_OVERRIDE
        });
        rec.getCurrentSublistField({
            sublistId: SUBLIST,
            fieldId: FLD_MACHINE
        }).isDisabled = !isOverride;
    }

    return { pageInit, lineInit, fieldChanged };
});
