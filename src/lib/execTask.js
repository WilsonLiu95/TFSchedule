const moment = require('moment');
const path = require('path');
const fs = require('fs-extra');
const spawn = require('child_process').spawn;

// 执行一次任务
function* execTask(taskName) {
    var {
        mysqlClient,
        childProcessHandleCache
    } = this;

    try {
        // 1: 数据库查询该条任务,
        const data = yield mysqlClient.query(`select * from t_task_list where taskName='${taskName}'`);
        if (data.length === 0) {
            this.throwError(`(${taskName})-任务在数据库中已被删除，不再执行该任务`);
            return false;
        }
        const taskInfo = data[0];
        const {
            taskStatus, title
        } = taskInfo;

        /**
         * 2. 检验该任务是否可以创建新的进程运行
         *      1. taskStatus为0
         *      2. 本任务上一次执行的进程已结束
         */
        if (childProcessHandleCache[taskName]) { // 上一个任务子进程尚未退出
            return this.emit('taskLevelNotify', {
                type: 'lastJobHasNotEnd',
                taskName,
                title: `${taskName} ${title} (lastJobHasNotEnd)`,
                content: '任务当前正在执行未退出,跳过本次运行'
            });
        }
        if (taskStatus !== 0) {
            console.log(`(${taskName})-任务被设置为无效状态码taskStatus:${taskStatus}，跳过，不执行`);
            return false;
        }

        // 3. 使用子进程spawn接口运行任务
        yield spawnTask.apply(this, [taskInfo]);
    } catch (e) {
        this.throwError('execTask', e);
    }
}

function* spawnTask(taskInfo) {
    var {
        childProcessHandleCache,
        taskRootPath,
        command,
        entryFile
    } = this;
    var {
        taskName,
        title,
        detached,
        lastWarningTime,
        lastStartTime
    } = taskInfo;
    // 默认使用node运行，入口文件未index.js
    command = taskInfo.command || command;
    entryFile = taskInfo.entryFile || entryFile;

    var errorLogList = [];
    // 支持秒级，因此版本号暂时以秒为单位
    const taskVersion = moment().format('YYYYMM/DD/HHmmss');
    const taskExecFilePath = path.join(taskRootPath, taskName, entryFile);
    const taskLogFile = path.join(taskRootPath, taskName, `logs/${taskVersion}.log`);

    // 1. 检验任务入口文件是否存在，不存在则返回
    if (!fs.existsSync(taskExecFilePath)) {
        if (!moment(lastWarningTime).isAfter(lastStartTime)) { // 如果未告警过，则进行告警
            this.emit('taskLevelNotify', {
                type: 'entryFileIsNotExists',
                taskName,
                title: `${taskName} ${title} (entryFileIsNotExists)`,
                content: `${path.join(taskName, entryFile)} 入口文件不存在`
            });
        }
        return false;
    }

    // 调用 任务开始运行的钩子函数
    yield this.startExecTask({
        taskName,
        taskVersion
    });
    this.emit('taskStart', {
        taskName,
        taskVersion
    });
    childProcessHandleCache[taskName] = spawn(command, [taskExecFilePath], { detached: detached === 1 });
    const taskPid = `(pid:${childProcessHandleCache[taskName].pid})`;

    console.log(`执行任务${taskName}-${taskPid}: ${command} ${taskExecFilePath}`);

    // 确保日志文件存在
    fs.ensureFileSync(taskLogFile);

    // stdout输出到任务日志
    childProcessHandleCache[taskName].stdout.on('data', function (data) {
        var logItem = `${moment().format('YYYY-MM-DD HH:mm:ss')} stdout-${taskPid}: ${(new Buffer(data)).toString()}`;
        fs.appendFileSync(taskLogFile, logItem);
    });

    // stderr输出到任务日志
    childProcessHandleCache[taskName].stderr.on('data', function (data) {
        var logInfo = `${moment().format('YYYY-MM-DD HH:mm:ss')} stderr-${taskPid} ${(new Buffer(data)).toString()}`;
        // 为了保护自身对异常日志进行限制，DB只保存不超过50条的异常日志
        if (errorLogList.length < 50) {
            errorLogList.push(logInfo);
        }

        fs.appendFileSync(taskLogFile, logInfo);
    });
    // 每当出现以下情况时触发 'error' 事件：error事件不捕捉将导致父进程退出
    // 1.进程无法被衍生；
    // 2.进程无法被杀死；
    // 3.向子进程发送信息失败。
    childProcessHandleCache[taskName].on('error', (err) => {
        this.emit('taskEnd', {
            taskName,
            exitCode: 3,
            taskVersion,
            errorLogList: [JSON.stringify(err)]
        });
    });
    childProcessHandleCache[taskName].on('close', (exitCode, signalCode) => {
        var content;
        try {
            if (signalCode) {
                if (signalCode === 'SIGHUP') {
                    exitCode = 2; // 主动被杀死状态码为2
                    content = `(${taskName})-${taskPid}父进程主动杀死子进程，退出信号 SIGHUP,退出码exitCode设置为2`;
                } else {
                    exitCode = 3; // 其他退出信号
                    content = `(${taskName})-${taskPid}任务遇到未知退出信号${signalCode}, 退出码exitCode设置为3`;
                }
                errorLogList.push(content);
            } else {
                content = `(${taskName})-${taskPid}运行结束，退出码为${exitCode}`;
            }

            console.log(content);
            // 结束状态输出到任务日志
            fs.appendFileSync(taskLogFile, `${content}\n===========任务结束==========\n`);

            // 删除子进程句柄的引用，以释放内存
            delete childProcessHandleCache[taskName];
            this.emit('taskEnd', {
                taskName,
                exitCode,
                taskVersion,
                errorLogList
            });
        } catch (e) {
            this.throwError('child process close', e);
        }
    });
}

module.exports = {
    execTask
};
