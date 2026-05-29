/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/log'], (search, log) => {

    const SUBLIST = 'recmachcustrecord_bpc_planning_job';

    const FLD_OVERRIDE = 'custrecord_override_machine';
    const FLD_MACHINE = 'custrecord_bpc_planning_machine';
    const FLD_ITEM = 'custrecord_bpc_wo_item';
    const FLD_QTY = 'custrecord_bpc_planning_qty';
    const FLD_SETUP = 'custrecord_setup_operation';

    const FLD_RUN_RATE = 'custrecord_bpc_sky_planning_run_rate';
    const FLD_PLANNED_TIME = 'custrecord_bpc_sky_planned_time';

    const HEADER_PARENT_ITEM = 'custrecord_sky_parent_item';

    function pageInit(context) {}

    function lineInit(context) {
        if (context.sublistId !== SUBLIST) return;

        const rec = context.currentRecord;
        toggleMachineField(rec);
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) return;

        const rec = context.currentRecord;

        if (context.fieldId === FLD_OVERRIDE) {
            toggleMachineField(rec);
            return;
        }

        if (context.fieldId === FLD_MACHINE) {
            updateRunRateAndPlannedTime(rec);
        }
    }

    function toggleMachineField(rec) {
        const isOverride = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_OVERRIDE
        });

        rec.getCurrentSublistField({
            sublistId: SUBLIST,
            fieldId: FLD_MACHINE
        }).isDisabled = !isOverride;
    }

    function updateRunRateAndPlannedTime(rec) {
        const machine = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_MACHINE
        });

        const routingItem = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_ITEM
        });

        const qty = Number(rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_QTY
        })) || 0;

        const isSetup = rec.getCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FLD_SETUP
        });

        const parentItem = rec.getValue({
            fieldId: HEADER_PARENT_ITEM
        });

        log.debug('qty', qty)
        log.debug('isSetup', isSetup)
        log.debug('parentItem', parentItem)
        log.debug('routingItem', routingItem)
        log.debug('machine', machine)

        if (!machine || !routingItem || !parentItem) {
            clearRunRateFields(rec);
            return;
        }

        const rateInfo = findMachineRunRate({
            routingItem,
            machine,
            parentItem
        });
        log.debug('rateInfo', rateInfo)

        if (isSetup) {
            setCurrentLineValue(rec, FLD_RUN_RATE, '');

            if (rateInfo.setupTime) {
                setCurrentLineValue(rec, FLD_PLANNED_TIME, rateInfo.setupTime);
            }

            return;
        }

        const isMasterItem = String(routingItem) === String(parentItem);

        let runRate = null;

        if (isMasterItem) {
            runRate = rateInfo.defaultRate;
        } else {
            runRate = rateInfo.additionalRate || rateInfo.defaultRate;
        }

        if (!runRate) {
            clearRunRateFields(rec);
            return;
        }

        setCurrentLineValue(rec, FLD_RUN_RATE, runRate);

        if (qty) {
            const plannedTime = parseFloat(qty) / parseFloat(runRate);

            if (isFinite(plannedTime)) {
                setCurrentLineValue(rec, FLD_PLANNED_TIME, plannedTime.toFixed(2));
            }
        }
    }

    function findMachineRunRate(options) {
        const defaultAddCol = search.createColumn({
            name: 'custrecord_bpc_sky_default_add'
        });

        const runRateCol = search.createColumn({
            name: 'custrecord_bpc_sky_run_rate'
        });

        const setupTimeCol = search.createColumn({
            name: 'custrecord_bpc_sky_setup_time'
        });

        const runRateSearch = search.create({
            type: 'customrecord_bpc_sky_machine_run_rate_ta',
            filters: [
                ['custrecord_bpc_sky_item', 'anyof', options.routingItem],
                'AND',
                ['custrecord_bpc_sky_machine', 'anyof', options.machine],
                'AND',
                ['custrecord_sky_item_assembly', 'anyof', options.parentItem]
            ],
            columns: [
                defaultAddCol,
                runRateCol,
                setupTimeCol
            ]
        });

        const results = runRateSearch.run().getRange({ start: 0, end: 20 }) || [];

        const output = {
            defaultRate: null,
            additionalRate: null,
            setupTime: null
        };
        log.debug('results', results)

        results.forEach(result => {
            const typeText =
                result.getText(defaultAddCol) ||
                result.getValue(defaultAddCol) ||
                '';

            const runRate = result.getValue(runRateCol);
            const setupTime = result.getValue(setupTimeCol);

            if (setupTime && !output.setupTime) {
                output.setupTime = setupTime;
            }

            if (typeText === 'Default') {
                output.defaultRate = runRate;
            }

            if (typeText === 'Additional') {
                output.additionalRate = runRate;
            }
        });

        return output;
    }

    function setCurrentLineValue(rec, fieldId, value) {
        rec.setCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId,
            value,
            ignoreFieldChange: true
        });
    }

    function clearRunRateFields(rec) {
        setCurrentLineValue(rec, FLD_RUN_RATE, '');
        setCurrentLineValue(rec, FLD_PLANNED_TIME, '');
    }

    return {
        pageInit,
        lineInit,
        fieldChanged
    };
});
