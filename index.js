require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// Проверяем токен
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN || TOKEN === 'YOUR_TOKEN') {
    console.error('❌ Ошибка: Токен не настроен!');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 30000,
        timeout: 10,
        autoStart: true
    }
});

const db = new sqlite3.Database('reminders.db');

// Инициализация базы данных
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            reminder_text TEXT,
            reminder_time DATETIME,
            sent INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('❌ Ошибка создания таблицы:', err);
        } else {
            console.log('✅ База данных инициализирована');
        }
    });
});

// Правильная функция для преобразования локального времени в UTC
function localTimeToUTC(localTimeString) {
    const [datePart, timePart] = localTimeString.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = timePart.split(':').map(Number);
    
    // Создаем дату в локальном времени (система сама определит часовой пояс)
    const localDate = new Date(year, month - 1, day, hours, minutes);
    
    // Получаем смещение часового пояса в минутах
    const timezoneOffset = localDate.getTimezoneOffset();
    
    // Конвертируем в UTC: добавляем смещение (т.к. getTimezoneOffset() возвращает разницу в минутах от UTC)
    const utcDate = new Date(localDate.getTime() + (timezoneOffset * 60 * 1000));
    
    const utcTime = utcDate.toISOString().slice(0, 19).replace('T', ' ');
    
    console.log(`🕒 Конвертация времени:`);
    console.log(`   Локальное: ${localTimeString}`);
    console.log(`   UTC: ${utcTime}`);
    console.log(`   Смещение: ${timezoneOffset} минут`);
    
    return utcTime;
}

// Функция для преобразования UTC в локальное время для отображения
function utcToLocalTime(utcTimeString) {
    const utcDate = new Date(utcTimeString + 'Z');
    const localDate = new Date(utcDate.getTime() - (utcDate.getTimezoneOffset() * 60 * 1000));
    
    const year = localDate.getFullYear();
    const month = String(localDate.getMonth() + 1).padStart(2, '0');
    const day = String(localDate.getDate()).padStart(2, '0');
    const hours = String(localDate.getHours()).padStart(2, '0');
    const minutes = String(localDate.getMinutes()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Проверка, не является ли время уже прошедшим
function isPastTime(timeString) {
    const [datePart, timePart] = timeString.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = timePart.split(':').map(Number);
    
    const inputDate = new Date(year, month - 1, day, hours, minutes);
    const now = new Date();
    
    return inputDate <= now;
}

// Исправленная функция парсинга времени
function parseTime(timeString) {
    console.log(`🕒 Парсим время: "${timeString}"`);
    
    // Формат "2024-12-31 23:59" - считаем что это ЛОКАЛЬНОЕ время
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timeString)) {
        // Проверяем, не прошло ли уже это время
        if (isPastTime(timeString)) {
            throw new Error('Указанное время уже прошло');
        }
        
        const utcTime = localTimeToUTC(timeString);
        return {
            localTime: timeString,
            utcTime: utcTime
        };
    }
    
    // Формат "in X minutes" - добавляем к текущему времени
    if (timeString.startsWith('in ')) {
        const parts = timeString.split(' ');
        const amount = parseInt(parts[1]);
        const unit = parts[2].toLowerCase();
        
        console.log(`⏱️ Распознан относительный формат: ${amount} ${unit}`);
        
        const resultTime = new Date();
        
        if (unit.startsWith('minute')) {
            resultTime.setMinutes(resultTime.getMinutes() + amount);
        } else if (unit.startsWith('hour')) {
            resultTime.setHours(resultTime.getHours() + amount);
        } else if (unit.startsWith('day')) {
            resultTime.setDate(resultTime.getDate() + amount);
        } else {
            resultTime.setMinutes(resultTime.getMinutes() + amount);
        }
        
        // Проверяем, не получилось ли время в прошлом
        if (resultTime <= new Date()) {
            throw new Error('Указанное время уже прошло');
        }
        
        const localTime = resultTime.toISOString().slice(0, 16).replace('T', ' ');
        const utcTime = resultTime.toISOString().slice(0, 19).replace('T', ' ');
        
        console.log(`✅ Преобразовано в: локальное ${localTime}, UTC: ${utcTime}`);
        return {
            localTime: localTime,
            utcTime: utcTime
        };
    }
    
    throw new Error('Неверный формат времени');
}

// Стартовая команда
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const helpText = `
🤖 Бот-напоминалка

Команды:
/remind [текст] at [время] - создать напоминание
/debug - показать активные напоминания
/clear - удалить все мои напоминания
/time - показать текущее время

Примеры:
/remind Позвонить маме at 2024-12-31 20:00
/remind Встреча с коллегой at in 2 hours
/remind Принять таблетки at in 2 minutes

💡 Время указывается в формате ГГГГ-ММ-ДД ЧЧ:MM
    `;
    bot.sendMessage(chatId, helpText);
});

// Команда для показа текущего времени
bot.onText(/\/time/, (msg) => {
    const chatId = msg.chat.id;
    const now = new Date();
    const localTime = now.toLocaleString('ru-RU');
    const utcTime = now.toISOString().slice(0, 19).replace('T', ' ');
    
    const timeInfo = `
🕒 Текущее время:
📍 Локальное: ${localTime}
🌐 UTC: ${utcTime}
⏰ Часовой пояс: UTC${now.getTimezoneOffset() > 0 ? '-' : '+'}${Math.abs(now.getTimezoneOffset() / 60)}
    `;
    
    bot.sendMessage(chatId, timeInfo);
});

// Обработчик команды /remind
bot.onText(/\/remind (.+) at (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const reminderText = match[1];
    const reminderTime = match[2];
    
    console.log(`Создание напоминания: "${reminderText}" на время: ${reminderTime}`);
    
    try {
        // Парсим время
        const parsedTime = parseTime(reminderTime);
        
        // Логируем для отладки
        const nowUTC = new Date().toISOString().slice(0, 19).replace('T', ' ');
        console.log(`⏰ Напоминание установлено на UTC: ${parsedTime.utcTime}`);
        console.log(`⏰ Текущее UTC: ${nowUTC}`);
        console.log(`⏰ Разница: ${(new Date(parsedTime.utcTime + 'Z') - new Date()) / 1000} секунд`);
        
        // Сохраняем в базу
        db.run(
            'INSERT INTO reminders (chat_id, reminder_text, reminder_time) VALUES (?, ?, ?)',
            [chatId, reminderText, parsedTime.utcTime],
            function(err) {
                if (err) {
                    console.error('Ошибка базы данных:', err);
                    bot.sendMessage(chatId, '❌ Ошибка сохранения напоминания');
                } else {
                    console.log(`Напоминание сохранено с ID: ${this.lastID}`);
                    bot.sendMessage(chatId, `✅ Напоминание создано:\n"${reminderText}"\n⏰ на ${parsedTime.localTime}`);
                }
            }
        );
    } catch (error) {
        console.error('Ошибка создания напоминания:', error.message);
        bot.sendMessage(chatId, `❌ ${error.message}`);
    }
});

// Команда для отладки
bot.onText(/\/debug/, (msg) => {
    const chatId = msg.chat.id;
    
    const nowUTC = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    db.all(
        'SELECT * FROM reminders WHERE chat_id = ? ORDER BY reminder_time',
        [chatId],
        (err, rows) => {
            if (err) {
                bot.sendMessage(chatId, '❌ Ошибка базы данных');
                return;
            }
            
            let message = `🕒 Текущее время: ${new Date().toLocaleString('ru-RU')}\n`;
            message += `🌐 Текущее UTC: ${nowUTC}\n\n`;
            
            if (rows.length === 0) {
                message += '📭 Напоминаний нет';
            } else {
                message += `📋 Все напоминания (${rows.length}):\n\n`;
                rows.forEach(row => {
                    const status = row.sent ? '✅ Отправлено' : '⏳ Ожидает';
                    const localTime = utcToLocalTime(row.reminder_time);
                    const timeDiff = (new Date(row.reminder_time + 'Z') - new Date()) / 1000;
                    const timeLeft = timeDiff > 0 ? `через ${Math.round(timeDiff / 60)} мин` : 'ДОЛЖНО СРАБОТАТЬ';
                    
                    message += `📍 "${row.reminder_text}"\n`;
                    message += `⏰ ${localTime} (локальное)\n`;
                    message += `🌐 ${row.reminder_time} (UTC)\n`;
                    message += `🕒 ${timeLeft} | ${status}\n`;
                    message += `🆔 ID: ${row.id}\n\n`;
                });
            }
            
            bot.sendMessage(chatId, message);
        }
    );
});

// Команда для очистки напоминаний
bot.onText(/\/clear/, (msg) => {
    const chatId = msg.chat.id;
    
    db.run(
        'DELETE FROM reminders WHERE chat_id = ?',
        [chatId],
        function(err) {
            if (err) {
                bot.sendMessage(chatId, '❌ Ошибка при очистке напоминаний');
            } else {
                const deletedCount = this.changes;
                bot.sendMessage(chatId, `✅ Удалено напоминаний: ${deletedCount}`);
                console.log(`🗑️ Удалено ${deletedCount} напоминаний для chat_id: ${chatId}`);
            }
        }
    );
});

// Проверка напоминаний каждую минуту
setInterval(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    console.log(`\n🔍 Проверка напоминаний...`);
    console.log(`🕒 Локальное время: ${new Date().toLocaleString('ru-RU')}`);
    console.log(`🌐 Текущее UTC: ${now}`);
    
    // Находим напоминания для отправки
    db.all(
        'SELECT * FROM reminders WHERE reminder_time <= ? AND sent = 0',
        [now],
        (err, rows) => {
            if (err) {
                console.error('Ошибка при проверке напоминаний:', err);
                return;
            }
            
            if (rows.length > 0) {
                console.log(`📨 Найдено ${rows.length} напоминаний для отправки:`);
                
                rows.forEach(row => {
                    const localTime = utcToLocalTime(row.reminder_time);
                    console.log(`- "${row.reminder_text}" (id: ${row.id})`);
                    console.log(`  Локальное время: ${localTime}`);
                    console.log(`  UTC время: ${row.reminder_time}`);
                });
                
                // Отправляем напоминания
                rows.forEach(row => {
                    bot.sendMessage(row.chat_id, `⏰ Напоминание: ${row.reminder_text}`)
                        .then(() => {
                            db.run('UPDATE reminders SET sent = 1 WHERE id = ?', [row.id]);
                            console.log(`✅ Напоминание ${row.id} отправлено`);
                        })
                        .catch(err => {
                            console.error(`❌ Ошибка отправки:`, err.message);
                        });
                });
            } else {
                console.log('📭 Напоминаний для отправки нет');
            }
        }
    );
}, 60000);

// Обработчики ошибок
bot.on('polling_error', (error) => {
    console.error('❌ Ошибка polling:', error.code, error.message);
});

bot.on('error', (error) => {
    console.error('❌ Общая ошибка бота:', error);
});

// Корректное завершение работы
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка бота...');
    db.close();
    process.exit();
});

console.log('🚀 Бот запущен локально!');
console.log('📱 Перейдите в Telegram и отправьте /start вашему боту');
console.log('⏹️  Для остановки нажмите Ctrl+C');