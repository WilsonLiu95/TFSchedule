const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');

// 清除上个月所有任务的历史记录
function* clearTaskExecRecord(task_root_path, backExecRecordNum, G_pool_client) {
    // 默认保存一个月的数据
    backExecRecordNum = backExecRecordNum || 3;
    console.log(`根据团队配置只保存${backExecRecordNum}天任务执行记录`);
    // 先清除数据库过期记录

    var clearTime = moment().subtract(backExecRecordNum, 'd').format('YYYY-MM-DD 00:00:00');
    var sql = `delete from t_task_exec_list where start_time < '${clearTime}'`;
    console.log(sql)
    yield G_pool_client.query(sql);

    // 清除过期的文件
    var taskList = yield G_pool_client.query('select task_name,rule from t_task_list');

    taskList.map(({ task_name }) => {
        ['logs', 'history'].map(recordDir => {
            var recordPath = path.join(task_root_path, task_name, recordDir);
            var backTimeObj = moment().subtract(backExecRecordNum, 'd');
            var LastMonth = backTimeObj.clone().format('YYYYMM');
            if (!fs.existsSync(recordPath)) return false;
            fs.readdirSync(recordPath).map(monthDir => {
                // 清除之前的月份
                if (LastMonth > monthDir) {
                    var clearMonthPath = path.join(recordPath, monthDir);
                    console.log(`当前为您清理过期月份文件夹${path.relative(task_root_path, clearMonthPath)}`);
                    fs.removeSync(clearMonthPath);
                } else if (LastMonth = monthDir) { // 正好当月，则进入看需要删除哪些天
                    fs.readdirSync(path.join(recordPath, monthDir)).map(day => {
                        var lastDay = backTimeObj.clone().format('DD');
                        if (lastDay > day) {
                            var clearDayPath = path.join(recordPath, monthDir, day);
                            console.log(`当前为您清理过期日期的文件夹${path.relative(task_root_path, clearDayPath)}`);
                            fs.removeSync(clearDayPath);

                        }
                    })
                }
            });
        })
    });
}
exports.clearTaskExecRecord = clearTaskExecRecord;