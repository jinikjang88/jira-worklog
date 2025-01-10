const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

// 로깅 유틸리티
const Logger = {
    logFile: 'app.log',
    
    log(type, message, data = null) {
        const timestamp = new Date().toLocaleString('ko-KR', { 
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const logMessage = `[${timestamp}] [${type}] ${message}`;
        
        console.log(logMessage);
        if (data) {
            console.log(data);
        }

        // 파일에 로그 작성
        fs.appendFileSync(this.logFile, logMessage + '\n');
        if (data) {
            fs.appendFileSync(this.logFile, JSON.stringify(data, null, 2) + '\n');
        }
    },

    info(message, data = null) {
        this.log('INFO', message, data);
    },

    error(message, error = null) {
        this.log('ERROR', message, error);
        if (error?.stack) {
            fs.appendFileSync(this.logFile, error.stack + '\n');
        }
    },

    debug(message, data = null) {
        if (process.env.NODE_ENV === 'development') {
            this.log('DEBUG', message, data);
        }
    }
};

// JIRA 서비스
const JiraService = {
    async getWorkLogs(email, startDate) {
        Logger.info(`워크로그 조회 시작 - 이메일: ${email}, 날짜: ${startDate}`);
        
        const auth = Buffer.from(`${email}:${process.env.JIRA_API_TOKEN}`).toString('base64');
        const jql = encodeURIComponent(
            `project = ITO AND worklogAuthor = currentUser() AND worklogDate = "${startDate}" ORDER BY updated DESC`
        );
        
        try {
            const apiUrl = `${process.env.JIRA_URL}/rest/api/2/search?jql=${jql}&fields=worklog,summary`;
            Logger.debug('JIRA API 요청', { url: apiUrl });

            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Accept': 'application/json'
                }
            });
            
            Logger.debug('JIRA API 응답 성공', { 
                data: response.data,
                issueCount: response.data?.issues?.length 
            });
            
            return this.processWorklogResponse(response.data, startDate, email);
        } catch (error) {
            Logger.error('JIRA API 호출 실패', error);
            throw this.handleJiraError(error);
        }
    },

    processWorklogResponse(data, startDate, email) {
        const stats = { total: 0 };
        
        if (!data?.issues?.length) {
            Logger.info('검색된 이슈 없음');
            return stats;
        }

        data.issues.forEach(issue => {
            const worklogs = issue.fields?.worklog?.worklogs || [];
            
            worklogs.forEach(worklog => {
                const worklogDate = worklog.started.split('T')[0];

                if (startDate === worklogDate && email === worklog.author.emailAddress) {
                    Logger.info(issue.fields.summary);
                    if (!stats[issue.key]) {
                        stats[issue.key] = {
                            name: issue.fields.summary,
                            totalSeconds: 0,
                            link: `${process.env.JIRA_URL}/browse/${issue.key}`
                        };
                    }
                    stats[issue.key].totalSeconds += worklog.timeSpentSeconds;
                    stats.total += worklog.timeSpentSeconds;
                }
            });
        });
        
        Logger.info('워크로그 처리 완료', { 
            issueCount: Object.keys(stats).length - 1,
            totalSeconds: stats.total 
        });
        
        return stats;
    },

    handleJiraError(error) {
        const errorMessage = error.response?.data?.errorMessages?.join(', ') 
            || error.response?.data?.message 
            || '알 수 없는 JIRA API 오류';
        
        return new Error(`JIRA API 오류: ${errorMessage}`);
    }
};

// 윈도우 관리
class WindowManager {
    constructor() {
        this.mainWindow = null;
        this.serverProcess = null;
    }

    createWindow() {
        Logger.info('메인 윈도우 생성 시작');
        
        this.mainWindow = new BrowserWindow({
            width: 1024,
            height: 768,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            autoHideMenuBar: true,
            frame: true
        });

        this.mainWindow.setMenu(null);
        
        this.setupServer();
        
        this.mainWindow.on('closed', () => {
            Logger.info('메인 윈도우 종료');
            this.mainWindow = null;
        });
    }

    setupServer() {
        const expressApp = express();
        this.setupMiddleware(expressApp);
        this.setupRoutes(expressApp);

        const PORT = process.env.PORT || 3000;
        this.serverProcess = expressApp.listen(PORT, () => {
            Logger.info(`서버 시작 - 포트: ${PORT}`);
            this.mainWindow.loadURL(`http://localhost:${PORT}`);
        });
    }

    setupMiddleware(app) {
        app.use(express.json());
        app.use(cors());
        
        // 리소스 경로 설정
        let publicPath;
        let manualPath;
        if (app.get('env') === 'development') {
            publicPath = path.join(__dirname, 'public');
            manualPath = path.join(__dirname, 'manual');
        } else {
            // Electron 앱이 패키징된 경우
            if (process.resourcesPath) {
                // resources 디렉토리 내의 public 폴더
                publicPath = path.join(process.resourcesPath, 'app.asar', 'public');
                manualPath = path.join(process.resourcesPath, 'manual'); // asar 외부에 위치
            } else {
                // 일반적인 실행 경우
                publicPath = path.join(__dirname, 'public');
                manualPath = path.join(__dirname, 'manual');
            }
        }
        
        Logger.info('Static paths:', { publicPath, manualPath });
        
        // 정적 파일 제공
        app.use(express.static(publicPath));
        app.use('/manual', express.static(manualPath));
        
        // 루트 경로 처리
        app.get('/', (req, res) => {
            const indexPath = path.join(publicPath, 'index.html');
            Logger.info('Serving index.html from:', indexPath);
            res.sendFile(indexPath);
        });
    
        // 수정된 404 처리
        app.use((req, res, next) => {
            if (req.path.startsWith('/api/')) {
                next();
            } else {
                Logger.error('Resource not found:', {
                    path: req.path,
                    publicPath,
                    manualPath
                });
                res.status(404).send('Resource not found');
            }
        });
    }

    setupRoutes(app) {
        app.post('/api/worklog', async (req, res) => {
            const { email, startDate } = req.body;
            
            if (!email || !startDate) {
                Logger.error('잘못된 요청', { email, startDate });
                return res.status(400).json({ 
                    error: '이메일과 날짜는 필수 입력값입니다.' 
                });
            }

            try {
                const stats = await JiraService.getWorkLogs(email, startDate);
                res.json(stats);
            } catch (error) {
                Logger.error('워크로그 조회 실패', error);
                res.status(500).json({
                    error: error.message,
                    details: process.env.NODE_ENV === 'development' ? error.stack : undefined
                });
            }
        });

        // 에러 처리 미들웨어
        app.use((err, req, res, next) => {
            Logger.error('서버 에러', err);
            res.status(500).json({
                error: '서버 에러가 발생했습니다.',
                details: process.env.NODE_ENV === 'development' ? err.stack : undefined
            });
        });
    }
}

// 앱 초기화
const windowManager = new WindowManager();

app.on('ready', () => {
    Logger.info('앱 시작');
    windowManager.createWindow();
});

app.on('window-all-closed', () => {
    Logger.info('모든 윈도우 종료');
    if (process.platform !== 'darwin') {
        if (windowManager.serverProcess) {
            windowManager.serverProcess.close();
        }
        app.quit();
    }
});

app.on('activate', () => {
    Logger.info('앱 활성화');
    if (windowManager.mainWindow === null) {
        windowManager.createWindow();
    }
});