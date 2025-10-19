require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// Проверяем токен
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
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

// Упрощенная функция парсинга - ВСЕГДА используем UTC
function parseTime(timeString) {
    console.log(`🕒 Парсим время: "${timeString}"`);
    
    // Формат "2024-12-31 23:59" - считаем что это UTC+3 (Московское время)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timeString)) {
        const [datePart, timePart] = timeString.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hours, minutes] = timePart.split(':').map(Number);
        
        // Создаем дату в Московском времени (UTC+3) и конвертируем в UTC
        const moscowTime = new Date(Date.UTC(year, month - 1, day, hours, minutes));
        moscowTime.setHours(moscowTime.getHours() - 3); // Вычитаем 3 часа для UTC
        
        const utcTime = moscowTime.toISOString().slice(0, 19).replace('T', ' ');
        
        console.log(`📅 Конвертация: ${timeString} (МСК) -> ${utcTime} (UTC)`);
        
        // Проверяем, не прошло ли время
        if (moscowTime <= new Date()) {
            throw new Error('Указанное время уже прошло');
        }
        
        return {
            localTime: timeString,
            utcTime: utcTime
        };
    }
    
    // Формат "in X minutes" - добавляем к текущему UTC времени
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
        
        const utcTime = resultTime.toISOString().slice(0, 19).replace('T', ' ');
        const moscowTime = new Date(resultTime.getTime() + (3 * 60 * 60 * 1000)); // +3 часа для МСК
        
        const localTimeStr = moscowTime.toISOString().slice(0, 16).replace('T', ' ');
        
        console.log(`✅ Преобразовано в: ${localTimeStr} (МСК), ${utcTime} (UTC)`);
        return {
            localTime: localTimeStr,
            utcTime: utcTime
        };
    }
    
    throw new Error('Неверный формат времени. Используйте: "2024-12-31 20:00" или "in 5 minutes"');
}

// Флаг для отслеживания обработки сообщений
const processingMessages = new Set();

// Стартовая команда - используем once чтобы избежать дублирования
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    
    // Проверяем, не обрабатывается ли уже это сообщение
    if (processingMessages.has(messageId)) {
        return;
    }
    processingMessages.add(messageId);
    
    const helpText = `
🤖 Бот-напоминалка (работает на Render)

Команды:
/remind [текст] at [время] - создать напоминание
/debug - показать активные напоминания  
/clear - удалить все мои напоминания
/time - показать текущее время

Примеры:
/remind Позвонить маме at 2024-12-31 20:00
/remind Встреча с коллегой at in 2 hours
/remind Принять таблетки at in 2 minutes

💡 Время указывается в Московском часовом поясе (UTC+3)
    `;
    
    bot.sendMessage(chatId, helpText)
        .finally(() => {
            // Удаляем сообщение из обработки через секунду
            setTimeout(() => {
                processingMessages.delete(messageId);
            }, 1000);
        });
});

// Команда для показа текущего времени
bot.onText(/\/time/, (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    
    if (processingMessages.has(messageId)) return;
    processingMessages.add(messageId);
    
    const now = new Date();
    const moscowTime = new Date(now.getTime() + (3 * 60 * 60 * 1000)); // UTC+3
    
    const timeInfo = `
🕒 Текущее время:
📍 Москва: ${moscowTime.toISOString().slice(0, 16).replace('T', ' ')}
🌐 UTC: ${now.toISOString().slice(0, 16).replace('T', ' ')}
⏰ Сервер: ${now.toLocaleString('ru-RU')}
    `;
    
    bot.sendMessage(chatId, timeInfo)
        .finally(() => {
            setTimeout(() => {
                processingMessages.delete(messageId);
            }, 1000);
        });
});

// Обработчик команды /remind - ОДИН обработчик
let isProcessingRemind = false;

bot.onText(/\/remind (.+) at (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    
    // Защита от дублирования - проверяем, не обрабатывается ли уже это сообщение
    if (processingMessages.has(messageId)) {
        console.log('⚠️ Сообщение уже обрабатывается, пропускаем...');
        return;
    }
    processingMessages.add(messageId);
    
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
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO reminders (chat_id, reminder_text, reminder_time) VALUES (?, ?, ?)',
                [chatId, reminderText, parsedTime.utcTime],
                function(err) {
                    if (err) {
                        console.error('Ошибка базы данных:', err);
                        reject(err);
                    } else {
                        console.log(`Напоминание сохранено с ID: ${this.lastID}`);
                        resolve(this.lastID);
                    }
                }
            );
        });
        
        // Отправляем ОДНО сообщение об успехе
        await bot.sendMessage(chatId, `✅ Напоминание создано:\n"${reminderText}"\n⏰ на ${parsedTime.localTime} (МСК)`);
        
    } catch (error) {
        console.error('Ошибка создания напоминания:', error.message);
        // Отправляем ОДНО сообщение об ошибке
        await bot.sendMessage(chatId, `❌ ${error.message}`);
    } finally {
        // Очищаем флаг обработки
        setTimeout(() => {
            processingMessages.delete(messageId);
        }, 1000);
    }
});

// Команда для отладки
bot.onText(/\/debug/, (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    
    if (processingMessages.has(messageId)) return;
    processingMessages.add(messageId);
    
    const nowUTC = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const nowMoscow = new Date(new Date().getTime() + (3 * 60 * 60 * 1000));
    
    db.all(
        'SELECT * FROM reminders WHERE chat_id = ? ORDER BY reminder_time',
        [chatId],
        (err, rows) => {
            if (err) {
                bot.sendMessage(chatId, '❌ Ошибка базы данных')
                    .finally(() => {
                        setTimeout(() => {
                            processingMessages.delete(messageId);
                        }, 1000);
                    });
                return;
            }
            
            let message = `🕒 Текущее время:\n`;
            message += `📍 Москва: ${nowMoscow.toISOString().slice(0, 16).replace('T', ' ')}\n`;
            message += `🌐 UTC: ${nowUTC.slice(0, 16)}\n\n`;
            
            if (rows.length === 0) {
                message += '📭 Напоминаний нет';
            } else {
                message += `📋 Активные напоминания (${rows.length}):\n\n`;
                rows.forEach(row => {
                    const status = row.sent ? '✅ Отправлено' : '⏳ Ожидает';
                    const moscowTime = new Date(new Date(row.reminder_time + 'Z').getTime() + (3 * 60 * 60 * 1000));
                    const localTimeStr = moscowTime.toISOString().slice(0, 16).replace('T', ' ');
                    const timeDiff = (new Date(row.reminder_time + 'Z') - new Date()) / 1000;
                    const timeLeft = timeDiff > 0 ? `через ${Math.round(timeDiff / 60)} мин` : 'ДОЛЖНО СРАБОТАТЬ';
                    
                    message += `📍 "${row.reminder_text}"\n`;
                    message += `⏰ ${localTimeStr} (МСК)\n`;
                    message += `🕒 ${timeLeft} | ${status}\n`;
                    message += `🆔 ID: ${row.id}\n\n`;
                });
            }
            
            bot.sendMessage(chatId, message)
                .finally(() => {
                    setTimeout(() => {
                        processingMessages.delete(messageId);
                    }, 1000);
                });
        }
    );
});

// Команда для очистки напоминаний
bot.onText(/\/clear/, (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    
    if (processingMessages.has(messageId)) return;
    processingMessages.add(messageId);
    
    db.run(
        'DELETE FROM reminders WHERE chat_id = ?',
        [chatId],
        function(err) {
            if (err) {
                bot.sendMessage(chatId, '❌ Ошибка при очистке напоминаний')
                    .finally(() => {
                        setTimeout(() => {
                            processingMessages.delete(messageId);
                        }, 1000);
                    });
            } else {
                const deletedCount = this.changes;
                bot.sendMessage(chatId, `✅ Удалено напоминаний: ${deletedCount}`)
                    .finally(() => {
                        setTimeout(() => {
                            processingMessages.delete(messageId);
                        }, 1000);
                    });
                console.log(`🗑️ Удалено ${deletedCount} напоминаний для chat_id: ${chatId}`);
            }
        }
    );
});

// Проверка напоминаний каждую минуту
setInterval(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const nowMoscow = new Date(new Date().getTime() + (3 * 60 * 60 * 1000));
    
    console.log(`\n🔍 Проверка напоминаний...`);
    console.log(`📍 Москва: ${nowMoscow.toISOString().slice(0, 16).replace('T', ' ')}`);
    console.log(`🌐 UTC: ${now}`);
    
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
                    const moscowTime = new Date(new Date(row.reminder_time + 'Z').getTime() + (3 * 60 * 60 * 1000));
                    console.log(`- "${row.reminder_text}" (id: ${row.id})`);
                    console.log(`  Москва: ${moscowTime.toISOString().slice(0, 16).replace('T', ' ')}`);
                    console.log(`  UTC: ${row.reminder_time}`);
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

console.log('🚀 Бот запущен на Render!');
console.log('📱 Перейдите в Telegram и отправьте /start вашему боту');