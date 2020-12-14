import mongoose, { mongo } from "mongoose";
import 'dotenv/config';
import DbBuffer from './DbBuffer';
import {
  hash,
  compare,
} from 'bcrypt';
import {
ErrorName,
  DbError,
  DbIdError,
  DbValueError,
  ScopeError
} from '../Errors';
//models start
import userModel from './models/userModel';
import tokenModel from './models/tokenModel';
import messagesModel from './models/messagesModel';
import conversationModel from './models/conversationModel';
import { ObjectID } from "mongodb";
//models end
import Scope, { ScopeBytes } from './Scope'
import { isMappedTypeNode } from "typescript";
import { raw } from "body-parser";

const ObjectId =  mongoose.Types.ObjectId;


interface IQuery {
  [key: string]: any,
}

export interface IMessage {
  _id: string,
  content: string,
  date: string,
  unread: boolean
}

export interface IMessages {
  fromId: string,
  messages: Array<IMessage>
}

export interface IUser {
  _id?: string,
  username?: string;
  name?: string,
  passwordHash?: string
}

export default class DbModule {

  private dbBuffer: DbBuffer;
  private uri: string;
  private isReady: boolean;

  constructor(uri: string) {
    this.dbBuffer = new DbBuffer();
    this.uri = uri;
    this.isReady = false;
  }

  async setup() {
    if (!this.isReady) {
      await mongoose.connect(this.uri, {useNewUrlParser: true, useUnifiedTopology: true});
      this.isReady = true;
    }
  }
  
  async save(object: mongoose.Document) {
    await object.save();
  }

  async deleteById(model: mongoose.Model<mongoose.Document, {}>, id: typeof ObjectId) {
    await model.findByIdAndDelete(id);
  }

  async findById(model: mongoose.Model<mongoose.Document, {}>, id: typeof ObjectId) {
      return await model.findById(id);
  }

  //await hash(user.toJSON()._id as string + (Math.random() as any as string), 10)
  async createToken(user: mongoose.Document, scope?: Scope, expiresIn?: number ){ 
    //expiresIn - time in miliseconds
    const newToken = new tokenModel({
      token: String(new ObjectId),
      userId: user.toObject()._id,
      scope: scope == undefined ? ScopeBytes.defaultScope : scope,
      expiresIn: undefined  == expiresIn ? 0 : expiresIn,
      date: (new Date()).getMilliseconds(),
      passwordHash: user.toObject().passwordHash
    });
    const stringToken = newToken.toObject().token;
    await this.save(newToken);
    return stringToken;
  }

  async createNewUser(email: string, password: string, username: string, name: string) {
    const newUser =  new userModel({
      _id: new ObjectId(), 
      email: email,
      passwordHash: await hash(password, 10),
      username: username,
      name: name
    });
    await this.save(newUser);
    const newConversations = new conversationModel({ user: newUser.toObject()._id })
    await this.save(newConversations);
    return newUser;
  }

  async getUserByEmail(email: string) {
    const result = (await this.find(userModel, {email: email}))[0];
    if(result == null) throw new DbValueError( `User with this email (${email}) does not exist.`);
    return result;
  }

  async getUserByUsername(username: string) {
    const result = (await this.find(userModel, {username: username}))[0];
    if(result == null) throw new DbValueError(`User with this username (${username}) does not exist.`);
    return result;
  }

  async getUserById(id: string) {
    const result = (await this.find(userModel, {_id: id}))[0];
    if(result == null) throw new DbValueError(`User with this id (${id}) does not exist.`);
    return result;
  }

  async findByIdAndUpdate(model: mongoose.Model<mongoose.Document, {}>, id: typeof ObjectId, changes: object) {
    await model.findByIdAndUpdate(id, changes);
  }

  async updateSafe(document: mongoose.Document, changes: object, current: object) {
    if(document == null) throw new DbValueError("Expected to get document.");
    let result = await this.checkValues(document, current);
    if(result) await document.updateOne(changes);
    return result;
  }

  async checkValues(document: mongoose.Document, object: object) {
    if(document == null) throw new DbValueError("Expected to get document.");
    let source = await document.toObject();
    if(source == null) throw new DbError("Document is empty.");
    for(let key of Object.keys(object)) {
      if(!source.hasOwnProperty(key) || (source[key] != (object as any)[key])) return false;
    }
    return true;
  }

  async find(model: mongoose.Model<mongoose.Document, {}>, object: object) {
    return await model.find(object);
  }

  async checkPassword(user: mongoose.Document, password: string) { //password is plain text
    //console.log(password, user.toObject().passwordHash, await compare(password, user.toObject().passwordHash));
    return await compare(password, user.toObject().passwordHash);
  }

  async getUserByToken(token: string) {
    const tokenDocument = (await this.find(tokenModel, {token: token}))[0];
    if(tokenDocument == undefined) throw new DbValueError("Token is not exists..");
    const userDocument = await this.findById(userModel, tokenDocument.toObject().userId);
    if(userDocument == null) throw new DbValueError('Owner of this token does not exist.');
    return userDocument;
  }

  async getToken(token: string) {
    const tokenDocument = (await this.find(tokenModel, {token: token}))[0];
    if(tokenDocument == undefined) throw new DbValueError("Token is not exists..");
    return tokenDocument;
  }

  async checkToken(token: mongoose.Document, methodName?: string) {
    const user = await this.getUserByToken(token.toObject().token);
    if(token.toObject().passwordHash != user.toObject().passwordHash) return false;
    if(token.toObject().expiresIn + token.toObject().date < (new Date()).getMilliseconds()) return false;
    if(methodName != undefined || (new Scope(token.toObject().scope)).checkMethod(String(methodName))) return false;
    return true;
  }

  async changePasswordSafe(token: string, currentPassword: string, newPassword: string) { //new password is plain text not hash
    let tokenDocument = await this.getToken(token);
    let userDocument = await this.getUserByToken(token);
    let result = await this.checkPassword(userDocument, currentPassword);
    //console.log(userDocument, currentPassword, await this.checkPassword(userDocument, currentPassword));
    if(result) {
      let newpasswordHash = await hash(newPassword, 10);
      //console.log(asd);
      await userDocument.updateOne({ passwordHash: newpasswordHash });
      return await this.createToken(userDocument, tokenDocument.toObject().scope, tokenDocument.toObject().expiresIn);
    } else throw new DbValueError('Incorrect password.');
  }

  async checkStringToken(token: string, methodName?: string) {
    return this.checkToken(await this.getToken(token), methodName);
  } 

  async changeNameSafe(token: string, currentName: string, newName: string) {
    let userDocument = await this.getUserByToken(token);
    let result = await this.updateSafe(
      userDocument, 
      {name: newName}, 
      {name: currentName}
      );
    if(result) return newName;
    else throw new DbValueError('Wrong current name.');
  }

  async getMessagesByUser(user: mongoose.Document) {
    // let result = (await this.find(messagesModel, { fromId: user.toObject()._id }))[0];
    // if(result == null) {
    //   let messagesDocument = new messagesModel( {
    //     _id: new ObjectID(),
    //     fromId: user.toObject()._id,
    //     histories : []
    //   });
    //   result = messagesDocument;
    //   await this.save(messagesDocument);
    // }
    // return result;
    let userId = await user.toObject()._id;
    return await this.getMessagesById(userId);
  }

  async getMessagesById(userId: string) {
    let result = (await this.find(messagesModel, { fromId: userId }))[0];
    if(result == null) {
      let messagesDocument = new messagesModel( {
        _id: new ObjectID(),
        fromId: userId,
        histories : []
      });
      result = messagesDocument;
      await this.save(messagesDocument);
    }
    return result;
  }

  async sendMessage (user: mongoose.Document, toUsername: string, content: string) {
    let messages = await this.getMessagesByUser(user);
    let toUserId = String((await this.getUserByUsername(toUsername)).toObject()._id);
    /* try {
      await messagesModel.updateOne(
        {
          'fromId': user.toObject()._id, 
        }, 
        { $push: { histories:  { 
          toId: (await this.getUserByUsername(toUsername)).toObject()._id,
          messages: []
        }}
      });
    } catch(error) { console.log(error) }
    console.log(await messagesModel.findOne({
      'fromId': user.toObject()._id, 
      histories: {
       toId: (await this.getUserByUsername(toUsername)).toObject()._id
      }
     }));*/
    //if (messages.toObject().histories.) // WIP
    // await messagesModel.updateOne(
    //   {
    //     'fromId': user.toObject()._id, 
    //     histories: {
    //      toId: (await this.getUserByUsername(toUsername)).toObject()._id
    //     }
    //   }, 
    //   { $push: { histories:  { 
    //     messages: {
    //       content: content,
    //       date: (new Date()).toString(),
    //       unread: true
    //     }
    //   }}
    var message: IQuery = {};
    console.log(toUserId);
    message[`histories.${toUserId}.messages`] = {
        content: content,
        date: Date.now().toString(),
        unread: true
    }
    await messagesModel.updateOne({
          'fromId': user.toObject()._id
        }, 
        { $push: message }
    );
    var updateUnread: IQuery = {};
    updateUnread[`histories.${toUserId}.unread`] = true; 
    
    await messagesModel.updateOne({
      'fromId': user.toObject()._id
      }, 
      updateUnread
    );
    await this.addNewDialogue(user, toUsername);
  }

  async getMessages(fromId: string, toId: string , amount: number) { //WIP
    let messages = (await this.getMessagesById(fromId));
    var result: IMessages = {
      fromId: fromId,
      messages: new Array<IMessage>()
    }
    var findObject: IQuery = {};
    findObject[`histories.${toId}`] = { $slice:  -amount }
    var rawResult = await messagesModel.findOne({ fromId: fromId }, findObject);
    if (rawResult == null) throw new DbError(`${fromId} is unknonwn user id.`);
    result.messages = (rawResult.toObject().histories.get(toId).messages).slice(-amount);
    //console.log(result)
    return result;
  }

  async getAllMessages(firstId: string, toId: string, amount: number) {
    
  }

  async changeId(model: mongoose.Model<mongoose.Document, {}>, document: mongoose.Document) {
    let newObject = document.toObject()
    newObject._id = new ObjectID;
    const newDocument = new model(newObject);
    await document.deleteOne();
    await this.save(newDocument);
    return newDocument;
  }

  async getName(username: string) {
    return (await this.getUserByUsername(username)).toObject().name;
  }

  async getConversationsByUser(user: mongoose.Document) {
    const result = (await this.find(conversationModel, { user: user.toObject()._id }))[0];
    if(result == null) throw new DbError( `Conversations for this user does not exist.`);
    return result;
  }

  async blockUser(user: mongoose.Document, username: string) {
    let conversations = await this.getConversationsByUser(user);
    //let conversationObject = conversations.toObject();
    //conversationObject.blocked.push((await this.getUserByUsername(username)).toObject()._id);
    try {
      await conversationModel.updateOne({'_id': conversations.toObject()._id}, { $push: { blocked: {user: (await this.getUserByUsername(username)).toObject()._id }}});
    } catch (error) {}
  }

  async convertArrayOfIdToUsernames(array: Array<any>) {
    //console.log(array);
    for (let element of array) {
      console.log(element)
      element.username = await this.convertIdToUsername(String(element.user));
      element.user = undefined;
      element._id = undefined;
      console.log(element)
    }
  }

  async getBlocked(user: mongoose.Document) {
    let conversations  = await this.getConversationsByUser(user);
    let result = conversations.toObject().blocked;
    await this.convertArrayOfIdToUsernames(result);
    return result;
  }

  async getDialogues(user: mongoose.Document) {
    let conversations  = await this.getConversationsByUser(user);
    let result = conversations.toObject().dialogues;
    await this.convertArrayOfIdToUsernames(result);
    return result;

  }

  async convertIdToUsername(id?: string) {
    console.log(id);
    if(!id) return undefined;
    const userDocument = await this.getUserById(id!);
    return userDocument.toObject().username;
  }

  async deleteDialogue(user: mongoose.Document, username: string) {
    let conversations = await this.getConversationsByUser(user);
    //let conversationObject = conversations.toObject();
    //conversationObject.blocked.push((await this.getUserByUsername(username)).toObject()._id);
    try {
      await conversationModel.updateOne({'_id': conversations.toObject()._id}, { $pull: { dialogues: {user: (await this.getUserByUsername(username)).toObject()._id }}});
    } catch (error) {}
  }

  async unblockUser(user: mongoose.Document, username: string) {
    let conversations = await this.getConversationsByUser(user);
    //let conversationObject = conversations.toObject();
    //conversationObject.blocked.push((await this.getUserByUsername(username)).toObject()._id);
    try {
      await conversationModel.updateOne({'_id': conversations.toObject()._id}, { $pull: { blocked: {user: (await this.getUserByUsername(username)).toObject()._id }}});
    } catch (error) {}
  }

  async addNewDialogue(user: mongoose.Document, username: string) {
    let conversations = await this.getConversationsByUser(user);
    //let conversationObject = conversations.toObject();
    //conversationObject.blocked.push((await this.getUserByUsername(username)).toObject()._id);
    try {
      await conversationModel.updateOne({'_id': conversations.toObject()._id}, { $push: { dialogues: {user: (await this.getUserByUsername(username)).toObject()._id }}});
    } catch (error) {}
  }

}
