@echo off

cd /d C:\Users\ServerPC\Documents\erp

echo ======================================== >> C:\Users\ServerPC\Documents\erp\startup.log
echo Started: %date% %time% >> C:\Users\ServerPC\Documents\erp\startup.log
echo ======================================== >> C:\Users\ServerPC\Documents\erp\startup.log

npm run start:dev >> C:\Users\ServerPC\Documents\erp\startup.log 2>&1