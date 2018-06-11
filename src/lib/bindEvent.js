const co = require('co');
const moment = require('moment');
function* bindEvent() {
    var { mysqlClient } = this;
    var that = this;
    this.on('runTask', (taskName) => {
        co(function* () {
            yield that.execTask(taskName);
        });
    });

    this.on('taskEnd', function ({ taskName, exitCode, taskVersion, errorLogList }) {
        co(function* () {
            yield that.endExecTask({ taskName, exitCode, taskVersion, errorLogList });
        });
    });

    this.on('taskLevelNotify', ({ type, title, content, taskName }) => {
        // 除了删除任务以外的告警taskDelete
        var notifyListType = ['lastJobHasNotEnd', 'entryFileIsNotExists', 'closeError', 'addTask', 'modifyTask', 'killTask', 'outtimeTask', 'missrunTask'];

        co(function* () {
            var { notifyList } = that;
            if (notifyListType.indexOf(type) !== -1) {
                const taskListInfo = yield mysqlClient.query(`select * from t_task_list where taskName="${taskName}"`);
                // 如果是任务级别则直接告警任务相关人员
                if (taskListInfo[0] && taskListInfo[0].owner) {
                    notifyList = taskListInfo[0].owner;
                }
                yield mysqlClient.query(`update t_task_list SET lastWarningTime='${moment().format('YYYY-MM-DD HH:mm:ss')}' where taskName="${taskName}"`);
            }
            that.emit('notify', { title, content, notifyList });
        });
    });

    this.on('systemError', function ({ errMsg, error }) {
        var content = '';
        if (error) {
            content = error.name + error.message + errMsg.stack;
        }
        this.emit('notify', { title: errMsg, content, notifyList: that.notifyList });
    });
    this.on('notify', ({ title, content, notifyList }) => {
        console.warn('#notify#', title, content, notifyList);
    });
}

exports.bindEvent = bindEvent;
