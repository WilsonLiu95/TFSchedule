var checkTaskListExistsSql = `
CREATE TABLE IF NOT EXISTS t_task_list (
    id int(11) NOT NULL AUTO_INCREMENT,
    taskName varchar(64) NOT NULL COMMENT '任务命名，也是任务id，需要与文件夹目录一致',
    owner varchar(256) NOT NULL COMMENT '任务负责人列表以分号分隔，任务运行异常将对其进行告警',
    title varchar(64) DEFAULT NULL COMMENT '任务名称',
    description varchar(512) DEFAULT NULL COMMENT '任务描述',
    rule varchar(64) DEFAULT NULL COMMENT '定时器的规则',
    command varchar(256) DEFAULT NULL COMMENT '执行器，即以什么来执行',
    entryFile varchar(64) DEFAULT NULL COMMENT '执行器，即以什么来执行',
    taskVersion varchar(64) DEFAULT NULL COMMENT '当前运行任务的版本号',
    taskStatus tinyint(4) NOT NULL DEFAULT '0' COMMENT '任务的状态 0: 正常 1. 设置为无效(不影响当前正在运行的进程) 2. 设置为无效并且杀死当前进程',
    timeout int(11) NOT NULL DEFAULT '60' COMMENT '每次任务多久算超时，以秒为单位',
    lastStartTime datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次任务开始的时间',
    lastEndTime datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次任务结束的时间',
    lastWarningTime datetime DEFAULT CURRENT_TIMESTAMP COMMENT '上次超时发送警告的时间',
    lastExitCode varchar(64) DEFAULT NULL COMMENT '上次退出的状态 0:正常 1: error触发的关闭 2: 子进程被父进程杀死 100以内为保留状态码，任务自定义使用100以上的状态码',
    modify_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '修改时间',
    create_time datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    operator varchar(64) DEFAULT NULL COMMENT '操作者',
    PRIMARY KEY (id),
    UNIQUE KEY task_id (taskName)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8;
`;

var checkTaskExecListExistsSql = `
CREATE TABLE IF NOT EXISTS t_task_exec_list (
  id int(11) NOT NULL AUTO_INCREMENT,
  taskName varchar(64) NOT NULL COMMENT '任务命名，也是任务id，需要与文件夹目录一致',
  taskVersion varchar(64) DEFAULT NULL COMMENT '本次执行的版本号',
  startTime DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '任务开始的时间',
  endTime DATETIME COMMENT '任务结束的时间',
  exitCode int(11) COMMENT '退出的状态 0:正常 1: error触发的关闭 2: 子进程被父进程杀死 100以内为保留状态码，任务自定义使用100以上的状态码',
  warningTime DATETIME DEFAULT NULL COMMENT '上次超时发送警告的时间',
  duration int(11) DEFAULT 0 COMMENT '任务执行时间',
  errorLogs text DEFAULT NULL COMMENT '本次版本的日志输出',
  publishFileList text DEFAULT NULL COMMENT '发布文件列表',
  primary key(id)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8;
`;
function clearTaskExecRecordTpl(config) {
    var clearTaskExecRecordCode = `
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const co = require('co');
const mysql = require('promise-mysql');

// 清除上个月所有任务的历史记录

co(function* () {
    var config = ${JSON.stringify(config)};
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
}`;
    return clearTaskExecRecordCode;
}

module.exports = { checkTaskExecListExistsSql, checkTaskListExistsSql, clearTaskExecRecordTpl };
