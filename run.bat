@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

:menu
cls
echo ============================================
echo   BPO Validate Tool
echo ============================================
echo [1] Validate CSV + Checktime (chi terminal)
echo [2] Validate CSV (+HTML)
echo [3] Capture + Summary (+HTML)
echo [4] Summary (chi terminal)
echo [5] So sanh CSV truoc/sau (CSV Diff)
echo [6] Capture song song + Summary (nhieu cua so)
echo [0] Thoat
echo ============================================
choice /c 1234560 /n /m "Chon muc: "

if errorlevel 7 goto end
if errorlevel 6 goto run_6
if errorlevel 5 goto run_5
if errorlevel 4 goto run_4
if errorlevel 3 goto run_3
if errorlevel 2 goto run_2
if errorlevel 1 goto run_1
goto menu

:run_1
echo.
echo Dang chay Validate CSV (chi terminal)...
node validate.js csv
set "rc=%errorlevel%"
echo.
echo Ket qua Validate: exit code %rc%
echo.
where python >nul 2>nul
if errorlevel 1 goto run_1_nopython
echo Dang chay Checktime...
python checktime\checktime.py csv
set "checktime_rc=%errorlevel%"
echo.
echo Ket qua Checktime: exit code %checktime_rc%
goto run_1_pause

:run_1_nopython
echo Khong tim thay Python trong PATH, bo qua buoc Checktime.
echo Goi y: cai dat Python hoac chay tay bang lenh "python checktime\checktime.py csv"

:run_1_pause
pause
goto menu

:run_2
echo.
echo Dang chay Validate CSV...
node validate.js csv --html
set "rc=%errorlevel%"
echo.
echo Ket qua Validate: exit code %rc%
if exist "validate-report.html" (
    start "" "validate-report.html"
)
pause
goto menu

:run_3
call :do_capture
if "!capture_skipped!"=="1" (
    pause
    goto menu
)
if "!capture_rc!"=="0" goto flow4_summary
choice /c YN /n /m "Capture ket thuc voi loi (exit code !capture_rc!). Ban co muon tiep tuc chay Summary khong? (Y/N): "
if errorlevel 2 (
    pause
    goto menu
)
goto flow4_summary

:flow4_summary
call :do_summary
pause
goto menu

:run_4
echo.
echo Dang chay Summary (chi terminal)...
node summary\summary.js csv
set "rc=%errorlevel%"
echo.
echo Ket qua Summary: exit code %rc%
pause
goto menu

:run_5
echo.
echo ============================================
echo   So sanh hai file CSV export cua CUNG MOT video:
echo   mot ban TRUOC khi sua, mot ban SAU khi sua.
echo   Bao cao gom cac vung thay doi: doi noi dung, doi vi tri,
echo   doi loai event, them moi, bi mat.
echo   Co the keo tha file vao cua so nay de dan duong dan.
echo ============================================
set "diff_before="
set "diff_after="
set /p "diff_before=Duong dan file CSV BAN TRUOC (ban cu): "
set /p "diff_after=Duong dan file CSV BAN SAU (ban moi): "

if defined diff_before set diff_before=!diff_before:"=!
if defined diff_after set diff_after=!diff_after:"=!

if not defined diff_before goto run_5_missing
if not defined diff_after goto run_5_missing

echo.
echo Dang chay CSV Diff...
node csv-diff.js "!diff_before!" "!diff_after!"
set "rc=!errorlevel!"
echo.
echo Ket qua CSV Diff: exit code !rc!
echo   0 = hai file khong khac nhau ve noi dung
echo   1 = co khac, xem muc CAC VUNG THAY DOI o tren
pause
goto menu

:run_5_missing
echo.
echo Can nhap du duong dan ca hai file.
pause
goto menu

:run_6
echo.
echo ============================================
echo   Capture song song: mo nhieu cua so trinh duyet cung luc,
echo   moi cua so xu ly mot phan cac file CSV trong thu muc csv.
echo   Moi cua so chi can dang nhap MOT lan du xu ly nhieu file.
echo   Chup xong tat ca se tu tong hop bao cao mot lan.
echo.
echo   LUU Y: moi cua so chi cho dang nhap 5 phut, va cac dong ho
echo   nay chay SONG SONG (khong cong don). Hay dang nhap ngay
echo   khi tung cua so hien ra, dung roi may.
echo.
echo   File CSV van phai co ten ket thuc bang (video_id).csv
echo ============================================
set "conc="
set /p "conc=So cua so chay cung luc (1-10): "
if not defined conc goto run_6_missing

echo.
echo Dang chay Capture song song...
node capture-parallel.js csv --concurrency=!conc!
set "rc=!errorlevel!"
echo.
echo Ket qua: exit code !rc!
if exist "summary-report.html" (
    start "" "summary-report.html"
)
pause
goto menu

:run_6_missing
echo.
echo Can nhap so cua so chay cung luc.
pause
goto menu

:do_capture
set "capture_skipped=0"
set "capture_rc="
echo.
echo ============================================
echo   Lưu ý trước khi chạy Capture:
echo   1. File CSV phải có tên kết thúc bằng (video_id).csv
echo      thì capture mới nhận, ví dụ: tran_dau(123456).csv
echo   2. Capture sẽ mở trình duyệt và cần bạn đăng nhập tay
echo      (chờ tối đa 5 phút).
echo ============================================
choice /c YN /n /m "Ban co muon tiep tuc chay Capture khong? (Y/N): "
if errorlevel 2 (
    set "capture_skipped=1"
    goto :eof
)
echo.
echo Dang chay Capture screenshots...
node capture\capture.js csv
set "capture_rc=%errorlevel%"
echo.
echo Ket qua Capture: exit code !capture_rc!
goto :eof

:do_summary
echo.
echo Dang chay Summary...
node summary\summary.js csv --html
set "rc=%errorlevel%"
echo.
echo Ket qua Summary: exit code !rc!
if exist "summary-report.html" (
    start "" "summary-report.html"
)
goto :eof

:end
endlocal
exit /b 0
