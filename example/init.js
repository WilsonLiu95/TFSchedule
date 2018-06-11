var { TFSchedule } = require('../src/index');
var scheHandle = new TFSchedule({
    backExecRecordNum: 1,
    mysqlConfig: {
        host: 'localhost',
        port: '3306',
        user: 'root',
        password: '1234',
        database: 'db_schedule'
    },
    taskRootPath: __dirname + '/task',
    notifyList: 'wilsonsliuxyz@gmail.com'
});
// var co = require('co');
// co(function* () {
//     yield scheHandle.clearTaskExecRecord();
// });

