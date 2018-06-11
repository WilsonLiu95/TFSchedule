
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const co = require('co');
const mysql = require('promise-mysql');

// 清除上个月所有任务的历史记录

co(function* () {
    var config = {"backExecRecordNum":1,"mysqlConfig":{"host":"localhost","port":"3306","user":"root","password":"1234","database":"db_schedule"},"taskRootPath":"/Users/wilsonsliu/workspace/git/gitoa/TFSchedule/example/task","notifyList":"wilsonsliuxyz@gmail.com"};
    yield clearTaskExecRecord(config);
});
function* clearTaskExecRecord({taskRootPath, backExecRecordNum, mysqlConfig}) {
    try {
        const mysqlClient = yield mysql.createConnection(mysqlConfig);
        const clearTime = moment().subtract(backExecRecordNum, 'd').format('YYYY-MM-DD 00:00:00');
        console.log('根据团队配置只保存' + backExecRecordNum + '天任务执行记录');
        // 先清除数据库过期记录
        yield mysqlClient.query(mysql.format('delete from t_task_exec_list where startTime < ?', [clearTime]));

        // 清除过期的文件
        const taskList = yield mysqlClient.query('select taskName,rule from t_task_list');

        taskList.map(({ taskName }) => {
            ['logs', 'history'].map(recordDir => {
                var recordPath = path.join(taskRootPath, taskName, recordDir);
                var backTimeObj = moment().subtract(backExecRecordNum, 'd');
                var LastMonth = backTimeObj.clone().format('YYYYMM');
                if (!fs.existsSync(recordPath)) { return false; }
                fs.readdirSync(recordPath).map(monthDir => {
                    var clearMonthPath = path.join(recordPath, monthDir);

                    if (!fs.statSync(clearMonthPath).isDirectory()) {
                        console.error(recordPath + '不符合批跑规范，不进行清理，请留意');
                        return false;
                    }
                    // 清除之前的月份
                    if (LastMonth > monthDir) {
                        console.log('当前为您清理过期月份文件夹' + path.relative(taskRootPath, clearMonthPath));
                        fs.removeSync(clearMonthPath);
                    } else if (LastMonth === monthDir) { // 正好当月，则进入看需要删除哪些天
                        fs.readdirSync(clearMonthPath).map(day => {
                            var lastDay = backTimeObj.clone().format('DD');
                            var clearDayPath = path.join(clearMonthPath, day);
                            if (lastDay - day > 0) {
                                console.log('当前为您清理过期日期的文件夹'
                                    + path.relative(taskRootPath, clearDayPath));
                                fs.removeSync(clearDayPath);
                            } else {
                                console.log('尚不需要清理' + path.relative(taskRootPath, clearDayPath));
                            }
                        });
                    }
                });
            });
        });
        mysqlClient.end();
    } catch (e) {
        console.error(e);
        process.exit(101);
    }
}