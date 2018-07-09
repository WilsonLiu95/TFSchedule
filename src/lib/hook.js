/*
    @filename: hook.js
    @author: wilsonsliu(wilsonsliu@tencent.com)
    @intro: 批跑系统执行的钩子函数，包括任务开始与结束
*/
const path = require('path');
const moment = require('moment');
const fs = require('fs-extra');
const dir = require('node-dir');
const mysql = require('promise-mysql');

// 任务开始执行的钩子函数
function* startExecTask({ taskName, taskVersion }) {
    var { taskRootPath, mysqlClient } = this;
    try {
        // 1. 置空发布文件夹
        const taskPublishDir = path.join(taskRootPath, taskName, 'publish');
        fs.emptyDirSync(taskPublishDir);

        // 2. 更新任务表中的lastStartTime与taskVersion
        const nowTimeStr = moment().format('YYYY-MM-DD HH:mm:ss');
        const updateSql = `update t_task_list SET lastStartTime='${nowTimeStr}', taskVersion='${taskVersion}' where taskName = '${taskName}'`;
        yield mysqlClient.query(updateSql);

        // 3. 插入一条任务执行记录
        const insertTaskExecSql = `INSERT INTO t_task_exec_list (taskName, taskVersion, startTime) VALUES ('${taskName}','${taskVersion}', '${nowTimeStr}')`;
        yield mysqlClient.query(insertTaskExecSql);
    } catch (e) {
        this.throwError('startExecTask', e);
    }
}

// 任务执行结束的钩子函数
function* endExecTask({ taskName, exitCode, taskVersion, errorLogList }) {
    var { mysqlClient, taskRootPath } = this;
    try {
        const taskPublishDir = path.join(taskRootPath, taskName, 'publish');
        // 1. 设置退出的事件与退出码

        const updateSql = `update t_task_list SET lastEndTime='${moment().format('YYYY-MM-DD HH:mm:ss')}',lastExitCode=${exitCode} where taskName = '${taskName}'`;
        yield mysqlClient.query(updateSql);

        // 任务执行不成功,进行告警
        if (exitCode !== 0) {
            this.emit('taskLevelNotify', {
                type: 'closeError', exitCode, taskName, taskVersion,
                title: `${taskName} (closeError)`,
                content: `退出错误码:${exitCode} \n ${errorLogList.join('\n')}`
            });
        }

        // 2. 备份发布文件夹
        yield backupPublish.apply(this, [{ taskName, taskRootPath, taskVersion }]);
        // 3. 更新任务运行记录
        yield updateTaskExec.apply(this, [{ taskName, exitCode, taskVersion, errorLogList, taskPublishDir }]);
    } catch (e) {
        this.throwError('endExecTask', e);
    }
}

// 更新任务执行记录
function* updateTaskExec({ taskName, exitCode, taskVersion, errorLogList, taskPublishDir }) {
    var { mysqlClient } = this;
    var warningTime, data, publishFileList = [];
    try {
        data = yield mysqlClient.query(`select * from t_task_list where taskName='${taskName}'`);
        const { lastStartTime, lastEndTime, lastWarningTime } = data[0];

        // 读取该任务的 日志文件与publish目录下的文件
        const absolutePathList = yield dir.promiseFiles(taskPublishDir);
        absolutePathList.map(filePath => { // 将绝对路径转化为相对路径
            var fileName = path.relative(taskPublishDir, filePath);
            publishFileList.push(path.join(taskName, 'history', taskVersion, fileName));
        });

        const duration = moment(lastEndTime).diff(moment(lastStartTime), 'seconds');
        const endTime = moment(lastEndTime).format('YYYY-MM-DD HH:mm:ss');
        if (moment(lastWarningTime).isAfter(lastStartTime)) {
            warningTime = moment(lastWarningTime).format('YYYY-MM-DD HH:mm:ss');
        }
        const updateSql = mysql.format(`update t_task_exec_list set endTime=?, warningTime=?, exitCode=? , errorLogs=? ,
            publishFileList=?,duration=? where taskName='${taskName}' and taskVersion='${taskVersion}'`
            , [endTime, warningTime, exitCode, errorLogList.join('<<<<>>>>'), publishFileList.toString(), duration]);
        console.log(`(${taskName}-${taskVersion})-执行完成，耗时${duration}秒,退出码${exitCode}`);
        yield mysqlClient.query(updateSql);
    } catch (e) {
        this.throwError(`updateTaskExec ${taskName} select error`, e);
    }
}

// 将本次发布文件移动到历史文件目录下，并置空发布文件夹
function* backupPublish({ taskName, taskRootPath, taskVersion }) {
    var publishDirFile;
    try {
        const taskRootDir = path.join(taskRootPath, taskName);
        const taskHistoryDir = path.join(taskRootDir, 'history');
        const taskPublishDir = path.join(taskRootDir, 'publish');

        const destPath = path.join(taskHistoryDir, taskVersion);

        publishDirFile = fs.readdirSync(taskPublishDir);
        if (publishDirFile.length) { // 发布文件夹不为空才进行移动
            console.log(`(${taskName})-版本为${taskVersion}发布的文件复制到history目录予以备份`);
            fs.copySync(taskPublishDir, destPath); // 将上一个版本发布的文件保存
        }
    } catch (e) {
        this.throwError(`${taskName}-${taskVersion} backupPublish error`, e);
    }
}

module.exports = {
    startExecTask, endExecTask, backupPublish, updateTaskExec
};
