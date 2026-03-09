/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    function afterSubmit(context) {

        // EDIT ONLY
        if (context.type !== context.UserEventType.EDIT) return;

        var newRec = context.newRecord;
        var oldRec = context.oldRecord;
        var jobId = newRec.id;

      var s = search.create({
        type: 'customrecord_sky_job',
        filters: [
          ["custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method","noneof","@NONE@"], 
          "AND", 
          [["custrecord_bpc_planning_job.custrecord_bpc_planning_op_name","contains","Run"],"OR",["custrecord_bpc_planning_job.custrecord_bpc_planning_op_name","contains","Setup"]], 
          "AND", 
          ["internalid","anyof",jobId]
        ],
        columns: [
      search.createColumn({
         name: "formulatext",
         summary: "GROUP",
         formula: "CASE  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 'Run'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Setup%' THEN 'Setup'  END",
         label: "Type"
      }),
      search.createColumn({
         name: "formulatext",
         summary: "GROUP",
         formula: "CASE   WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} IN   ('Traditional', 'Traditional : Screen Print', 'Traditional : Pad Print', 'Digital', 'Hi-Speed')   THEN 'Regular'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Hot Stamp'   THEN 'HO'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Emboss'   THEN 'EM'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Deboss'   THEN 'DE'END",
         label: "Machine"
      }),
      search.createColumn({
         name: "custrecord_bpc_planning_op_name",
         join: "CUSTRECORD_BPC_PLANNING_JOB",
         summary: "COUNT",
         label: "Operation Name"
      }),
      search.createColumn({
         name: "custrecord_bpc_planning_qty",
         join: "CUSTRECORD_BPC_PLANNING_JOB",
         summary: "SUM",
         label: "Quantity"
      }),
      search.createColumn({
         name: "custrecord_sky_no_impressions",
         summary: "MAX",
         label: "No. of Impressions"
      }),
      search.createColumn({
         name: "custrecord_sky_no_impressions_de",
         summary: "MAX",
         label: "No. of Impressions DE"
      }),
      search.createColumn({
         name: "custrecord_sky_no_impressions_em",
         summary: "MAX",
         label: "No. of Impressions EM"
      }),
      search.createColumn({
         name: "custrecord_sky_no_impressions_ho",
         summary: "MAX",
         label: "No. of Impressions HO"
      }),
      search.createColumn({
         name: "custrecord_sky_total_impressions",
         summary: "MAX",
         label: "Total of Impressions"
      }),
      search.createColumn({
         name: "custrecord_sky_total_impressions_de",
         summary: "MAX",
         label: "Total of Impressions DE"
      }),
      search.createColumn({
         name: "custrecord_sky_total_impressions_em",
         summary: "MAX",
         label: "Total of Impressions EM"
      }),
      search.createColumn({
         name: "custrecord_sky_total_impressions_ho",
         summary: "MAX",
         label: "Total of Impressions HO"
      })
   ]
      });
      var updateObj = {};
      var results = s.run().getRange({ start: 0, end: 1000 }) || [];
      if (!results.length) {
        log.debug('SKY Job', 'No search results. Nothing to update.');
        return;
      }
      
      for (var i = 0; i < results.length; i++) {
        var r = results[i];

       // log.debug('r', r)
        
        var groupText = r.getValue(s.columns[0]) || ''; // GROUP formulatext
        var groupType = r.getValue(s.columns[1]) || '';
        var opCount = Number(r.getValue(s.columns[2])) || 0; // COUNT
        var qtySum = Number(r.getValue(s.columns[3])) || 0;  // SUM
        var regOP = Number(r.getValue(s.columns[4])) || 0;
        var deOP = Number(r.getValue(s.columns[5])) || 0;
        var emOP = Number(r.getValue(s.columns[6])) || 0;
        var hoOP = Number(r.getValue(s.columns[7])) || 0;
        var regQTY = Number(r.getValue(s.columns[8])) || 0;
        var deQTY = Number(r.getValue(s.columns[9])) || 0;
        var emQTY = Number(r.getValue(s.columns[10])) || 0;
        var hoQTY = Number(r.getValue(s.columns[11])) || 0;

        log.debug('r', {groupText, groupType, opCount, qtySum, regOP, deOP, emOP, hoOP, regQTY, deQTY, emQTY, hoQTY})

        if (groupText == 'Setup') {
          if (groupType == 'Regular' && opCount != regOP) updateObj.custrecord_sky_no_impressions = opCount;
          else if (groupType == 'EM' && opCount != emOP) updateObj.custrecord_sky_no_impressions_em = opCount;
          else if (groupType == 'HO' && opCount != hoOP) updateObj.custrecord_sky_no_impressions_ho = opCount;
          else if (groupType == 'DE' && opCount != deOP) updateObj.custrecord_sky_no_impressions_de = opCount;
        }
        else if (groupText == 'Run') {
          if (groupType == 'Regular' && qtySum != regQTY) updateObj.custrecord_sky_total_impressions = qtySum;
          else if (groupType == 'EM' && qtySum != emQTY) updateObj.custrecord_sky_total_impressions_em = qtySum;
          else if (groupType == 'HO' && qtySum != hoQTY) updateObj.custrecord_sky_total_impressions_ho = qtySum;
          else if (groupType == 'DE' && qtySum != deQTY) updateObj.custrecord_sky_total_impressions_de = qtySum;
        }
      }
      
      log.debug('Grouped rows', JSON.stringify(updateObj));
      
      // --------- If we found a mismatch -> submitFields ----------
      if (Object.keys(updateObj).length) {
        record.submitFields({
          type: 'customrecord_sky_job',
          id: jobId,
          values: updateObj,
          options: {
            enableSourcing: false,
            ignoreMandatoryFields: true
          }
        });
        
      } else {
        log.debug('No update needed', 'Machine Run matched existing values.');
      }
        
        var newMachine = newRec.getValue('custrecord_sky_job_machine');
        var oldMachine = oldRec.getValue('custrecord_sky_job_machine');

        // Exit if machine did NOT change
        if (newMachine === oldMachine) return;

        var jobId = newRec.id;

        // Your search
        var s = search.create({
            type: "customrecord_bpc_job_planning_details",
            filters: [
                // ["custrecord_bpc_planning_op_name","contains","Machine"],
                // "AND",
                ["custrecord_bpc_planning_job","anyof", jobId],
                "AND",
                ["custrecord_override_machine","is","F"]
            ],
            columns: [
                "internalid"
            ]
        });

        s.run().each(function (res) {

            var recId = res.getValue('internalid');

            // Update machine using submitFields
            record.submitFields({
                type: 'customrecord_bpc_job_planning_details',
                id: recId,
                values: {
                    custrecord_bpc_planning_machine: newMachine
                }
            });

            return true;
        });
    }

    return {
        afterSubmit: afterSubmit
    };
});
