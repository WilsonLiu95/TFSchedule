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
scheHandle.on('notify', function(notifyInfo) {
    try {
        const { type, title, content, notifyList } = notifyInfo;
        console.log(`告警信息\n${JSON.stringify(notifyInfo)}`);
        title = 'TFSchedule批跑系统通知 ' + title;
        content = content || '';
        if (process.env.NODE_ENV === 'production') {
            notifySendRTX && notifySendRTX({
                title: title,
                msg: content,
                receiver: notifyList + ';wilsonsliu'
            });
        } else {
            console.log("notifyTaskRTX-本地开发环境，不发生警告");
        }
    } catch (e) {
        console.error('告警异常', e);
    }
});

function notifySendRTX() {
    // 通知函数
    console.log(arguments);
}
